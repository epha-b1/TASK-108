import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/environment';

const prisma = getPrisma();

const validUser = {
  username: `testuser_${Date.now()}`,
  password: 'ValidPassword1!',
  securityQuestions: [
    { question: 'What is your pet name?', answer: 'fluffy' },
    { question: 'What city were you born in?', answer: 'seattle' },
  ],
};

let accessToken: string;
let refreshToken: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Clean up test data
  const user = await prisma.user.findUnique({ where: { username: validUser.username } });
  if (user) {
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.device.deleteMany({ where: { userId: user.id } });
    await prisma.securityQuestion.deleteMany({ where: { userId: user.id } });
    await prisma.passwordHistory.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe('POST /auth/register', () => {
  it('201 — creates user and returns id + username', async () => {
    const res = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send(validUser);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.username).toBe(validUser.username);
  });

  it('409 — duplicate username', async () => {
    const res = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send(validUser);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('400 — password too short', async () => {
    const res = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      username: 'shortpw',
      password: 'Short1!',
      securityQuestions: validUser.securityQuestions,
    });
    expect(res.status).toBe(400);
    expect(res.status).toBe(400);
  });

  it('400 — password missing digit', async () => {
    const res = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      username: 'nodigit',
      password: 'NoDigitHere!!xx',
      securityQuestions: validUser.securityQuestions,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/digit/);
  });
});

describe('POST /auth/login', () => {
  it('200 — returns accessToken and refreshToken', async () => {
    const res = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: validUser.password,
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.username).toBe(validUser.username);
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('401 — wrong password', async () => {
    const res = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: 'WrongPassword1!',
    });
    expect(res.status).toBe(401);
  });

  // Lockout boundary — deterministic variant.
  //
  // The original shape looped 10 sequential bcrypt-backed login calls,
  // which pushed the test close to the Jest timeout on slow CI. We now
  // seed the first 9 failed-attempt rows directly in `login_attempts`
  // (the same table the service counts against the rolling 15-minute
  // window) and then make exactly ONE real HTTP login call to trip the
  // lockout. Zero bcrypt cost for the seeded rows, no wall-clock wait,
  // and the assertions are STRONGER than before:
  //
  //   1. the 10th wrong-password login returns the canonical 401 envelope
  //   2. the user row transitions to status='locked' with lockedUntil in the future
  //   3. a subsequent login with the CORRECT password is denied with 423
  //      (not 200) while still inside the lock window
  it('423 — account locks after 10 failed attempts AND correct password is denied during the lock window', async () => {
    const lockUser = {
      username: `locktest_${Date.now()}_${uuid()}`,
      password: 'ValidPassword1!',
      securityQuestions: validUser.securityQuestions,
    };
    const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send(lockUser);
    expect(reg.status).toBe(201);
    const userId: string = reg.body.id;

    // Seed 9 recent failed attempts directly — the service counts rows
    // in the last 15 minutes, so `createdAt: now()` default is fine.
    await prisma.loginAttempt.createMany({
      data: Array.from({ length: 9 }, () => ({ userId, success: false })),
    });

    // One real HTTP wrong-password login — this is the 10th attempt, which
    // trips `recentFailures >= MAX_FAILED_ATTEMPTS` and writes status='locked'
    // + lockedUntil = now + 15 min on the user row.
    const trip = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: lockUser.username, password: 'WrongPassword1!' });
    expect(trip.status).toBe(401);
    expect(trip.body.code).toBe('UNAUTHORIZED');
    expect(trip.body.requestId).toBe(trip.headers['x-request-id']);

    // DB invariant: the user is now locked, with lockedUntil strictly in
    // the future. No assertion on exact value — the service uses its own
    // Date.now() reference and we only care about direction.
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row?.status).toBe('locked');
    expect(row?.lockedUntil).not.toBeNull();
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Critical assertion: supplying the CORRECT password is still denied
    // while inside the lock window. Returns 423, NOT 200, NOT 401.
    const blocked = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: lockUser.username, password: lockUser.password });
    expect(blocked.status).toBe(423);
    expect(blocked.body.code).toBe('ACCOUNT_LOCKED');
    expect(blocked.body.message).toMatch(/locked/i);
    expect(blocked.body.requestId).toBe(blocked.headers['x-request-id']);

    // Clean up lockout user — must include the seeded loginAttempt rows.
    await prisma.loginAttempt.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  }, 20_000);
});

describe('POST /auth/refresh', () => {
  it('200 — returns new accessToken', async () => {
    const res = await request(app).post('/auth/refresh').set('Idempotency-Key', uuid()).send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('401 — invalid refresh token', async () => {
    const res = await request(app).post('/auth/refresh').set('Idempotency-Key', uuid()).send({ refreshToken: 'invalid-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('204 — revokes refresh token', async () => {
    // Login again to get a new refresh token to revoke
    const loginRes = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: validUser.password,
    });
    const logoutRefresh = loginRes.body.refreshToken;
    accessToken = loginRes.body.accessToken;

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', uuid())
      .send({ refreshToken: logoutRefresh });
    expect(res.status).toBe(204);

    // Verify the revoked token can't be used
    const refreshRes = await request(app).post('/auth/refresh').set('Idempotency-Key', uuid()).send({ refreshToken: logoutRefresh });
    expect(refreshRes.status).toBe(401);
  });

  it('400 VALIDATION_ERROR — missing refreshToken in body', async () => {
    // Re-login to get a fresh token (the previous test consumed access tokens too).
    const loginRes = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: validUser.password,
    });
    const freshAccess = loginRes.body.accessToken;

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${freshAccess}`)
      .set('Idempotency-Key', uuid())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBeDefined();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('400 VALIDATION_ERROR — empty refreshToken string', async () => {
    const loginRes = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: validUser.password,
    });
    const freshAccess = loginRes.body.accessToken;

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${freshAccess}`)
      .set('Idempotency-Key', uuid())
      .send({ refreshToken: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /auth/me', () => {
  it('200 — with valid Bearer token', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(validUser.username);
    expect(res.body.id).toBeDefined();
  });

  it('401 — no token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('401 — expired token', async () => {
    const expired = jwt.sign(
      { userId: 'fake', username: 'fake', role: 'organizer' },
      env.jwtSecret,
      { algorithm: 'HS256', expiresIn: -10 },
    );
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /auth/change-password', () => {
  it('200 — changes password successfully', async () => {
    const res = await request(app)
      .patch('/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        currentPassword: validUser.password,
        newPassword: 'NewPassword123!x',
      });
    expect(res.status).toBe(200);

    // Login with new password to get fresh token
    const loginRes = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: validUser.username,
      password: 'NewPassword123!x',
    });
    expect(loginRes.status).toBe(200);
    accessToken = loginRes.body.accessToken;
    refreshToken = loginRes.body.refreshToken;
  }, 15000);

  it('400 — reuse violation', async () => {
    // Try to reuse the password we just set
    const res = await request(app)
      .patch('/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        currentPassword: 'NewPassword123!x',
        newPassword: 'NewPassword123!x',
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reuse/i);
  }, 15000);
});
