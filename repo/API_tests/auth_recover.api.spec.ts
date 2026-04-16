/**
 * End-to-end coverage for `POST /auth/recover`.
 *
 * This flow is high-risk: a wrong answer should NOT reveal whether the
 * username is known, and a successful recovery MUST invalidate the old
 * password everywhere (login, password history, lock state) while the new
 * password works immediately.
 *
 * Every test drives the full middleware + controller + service + Prisma
 * stack (no transport-layer mocking). Error responses are checked against
 * the canonical error envelope (statusCode / code / message / requestId /
 * traceId) and the X-Request-Id header.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

// Answers stored in lowercase/trimmed form; test inputs deliberately mix
// case + trailing whitespace to prove the trim/lowercase comparison path.
const subjectCreds = {
  username: `recov_subject_${ts}`,
  password: 'OriginalPassw0rd!',
  securityQuestions: [
    { question: 'What is your pet name?', answer: 'Fluffy' },
    { question: 'What city were you born in?', answer: 'Seattle' },
  ],
};

const NEW_PASSWORD = 'Fresh!Passw0rd123';

let subjectUserId: string;

beforeAll(async () => {
  await prisma.$connect();

  const reg = await request(app)
    .post('/auth/register')
    .set('Idempotency-Key', uuid())
    .send(subjectCreds);
  expect(reg.status).toBe(201);
  subjectUserId = reg.body.id;
}, 15000);

afterAll(async () => {
  if (subjectUserId) {
    await prisma.refreshToken.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: subjectUserId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('POST /auth/recover — validation', () => {
  it('400 — missing payload fields are rejected with canonical envelope', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBeDefined();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(Array.isArray(res.body.details)).toBe(true);
    // Should list missing fields.
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['username', 'answers', 'newPassword']));
  });

  it('400 — empty answers array is rejected', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        answers: [],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — answer entries must have non-empty question AND answer', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        answers: [{ question: '', answer: '' }],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — weak new password is rejected (policy enforced by service)', async () => {
    // `newPassword` < 12 chars triggers Zod rejection at the route; the
    // canonical envelope is still the one produced by the validator.
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        answers: [
          { question: 'What is your pet name?', answer: 'fluffy' },
          { question: 'What city were you born in?', answer: 'seattle' },
        ],
        newPassword: 'short',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('400 — 12-char password that lacks an uppercase letter is rejected by policy', async () => {
    // Passes the zod `min(12)` but fails `validatePasswordPolicy` inside the
    // service → canonical envelope with service-originated VALIDATION_ERROR.
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        answers: [
          { question: 'What is your pet name?', answer: 'fluffy' },
          { question: 'What city were you born in?', answer: 'seattle' },
        ],
        newPassword: 'alllowercasenoup1!',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/uppercase/i);
  });
});

describe('POST /auth/recover — authorization checks', () => {
  it('401 — unknown username returns generic UNAUTHORIZED envelope (no username enumeration)', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: `ghost_user_${ts}_${uuid()}`,
        answers: [{ question: 'q', answer: 'a' }],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    // The message MUST be generic — no "username not found" disclosure.
    expect(res.body.message).toMatch(/Invalid username or answers/i);
    expect(res.body.message).not.toMatch(/not found|does not exist/i);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('401 — wrong answer to one of the questions is rejected with the SAME envelope', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        answers: [
          { question: 'What is your pet name?', answer: 'NotFluffy' }, // wrong
          { question: 'What city were you born in?', answer: 'seattle' },
        ],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    // Same message as the unknown-user case → no side-channel oracle.
    expect(res.body.message).toMatch(/Invalid username or answers/i);
    // Persistence: original password must still work.
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: subjectCreds.username, password: subjectCreds.password });
    expect(loginRes.status).toBe(200);
  });

  it('401 — missing one of the stored questions is also rejected', async () => {
    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        // Only 1 of 2 stored questions supplied.
        answers: [{ question: 'What is your pet name?', answer: 'fluffy' }],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /auth/recover — happy path', () => {
  it('200 — resets password; old password stops working; new password works; lock state clears', async () => {
    // Lock the user first so we can prove recovery clears the lock.
    await prisma.user.update({
      where: { id: subjectUserId },
      data: { status: 'locked', failedAttempts: 7, lockedUntil: new Date(Date.now() + 3600_000) },
    });

    const res = await request(app)
      .post('/auth/recover')
      .set('Idempotency-Key', uuid())
      .send({
        username: subjectCreds.username,
        // Mixed case + trailing spaces — the service trims+lowercases before
        // comparing, so these should match the stored answers.
        answers: [
          { question: '  What is your pet name?', answer: '  FLUFFY  ' },
          { question: 'What city were you born in?  ', answer: 'Seattle' },
        ],
        newPassword: NEW_PASSWORD,
      });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Password reset/i);

    // DB-state assertions: the account must be re-activated and the lock
    // fields cleared by the service.
    const row = await prisma.user.findUnique({ where: { id: subjectUserId } });
    expect(row?.status).toBe('active');
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();

    // Password history must have grown (recovery appends to history).
    const history = await prisma.passwordHistory.findMany({ where: { userId: subjectUserId } });
    expect(history.length).toBeGreaterThanOrEqual(2); // original at register + recovery

    // Old password must no longer work.
    const oldLogin = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: subjectCreds.username, password: subjectCreds.password });
    expect(oldLogin.status).toBe(401);

    // New password must work and issue valid tokens.
    const newLogin = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: subjectCreds.username, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.body.accessToken).toBe('string');
    expect(newLogin.body.user.username).toBe(subjectCreds.username);
  }, 20000);

  it('400 — reusing the just-set password via change-password is rejected (history tracked)', async () => {
    // Log in with the current password to get a fresh token.
    const loginRes = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ username: subjectCreds.username, password: NEW_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.accessToken;

    // Try to "change" to the SAME password that recovery just set — the last-5
    // history gate must reject it.
    const res = await request(app)
      .patch('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', uuid())
      .send({ currentPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reuse/i);
  }, 15000);
});
