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

  it('423 — after 10 failed attempts (locked)', async () => {
    // Create a throwaway user for lockout testing
    const lockUser = {
      username: `locktest_${Date.now()}`,
      password: 'ValidPassword1!',
      securityQuestions: validUser.securityQuestions,
    };
    await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send(lockUser);

    for (let i = 0; i < 10; i++) {
      await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
        username: lockUser.username,
        password: 'WrongPassword1!',
      });
    }

    const res = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send({
      username: lockUser.username,
      password: lockUser.password,
    });
    expect(res.status).toBe(423);

    // Clean up lockout user
    const u = await prisma.user.findUnique({ where: { username: lockUser.username } });
    if (u) {
      await prisma.passwordHistory.deleteMany({ where: { userId: u.id } });
      await prisma.securityQuestion.deleteMany({ where: { userId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
  }, 30000);
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
