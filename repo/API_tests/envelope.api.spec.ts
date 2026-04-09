/**
 * Parameterised error envelope + request-id consistency tests.
 *
 * Every non-2xx response in TripForge MUST carry the canonical error envelope:
 *
 *   { statusCode, code, message, requestId, traceId? }
 *
 * AND the `X-Request-Id` response header MUST be present and equal to the
 * `requestId` field in the body. Client-supplied `X-Request-Id` (or the legacy
 * `X-Trace-Id`) is echoed back unchanged.
 *
 * This suite is the safety net that catches drift across the whole API: if a
 * controller writes its own ad-hoc error shape, this suite breaks.
 *
 * Status codes covered:
 *   400 — validation error (POST /resources missing body)
 *   401 — no Bearer token on a protected route
 *   403 — non-admin hitting an admin-only route
 *   404 — unknown path
 *   409 — duplicate resource (we use the import idempotency key conflict path)
 *   429 — both branches of the unusual-location challenge flow:
 *           - CHALLENGE_REQUIRED (issuance branch with `challengeToken`)
 *           - RATE_LIMITED       (4th issuance in the rolling hour)
 *         The dedicated parameterised matrix below uses a fresh user/device
 *         for each branch so it's deterministic, plus there's a separate
 *         standalone suite at API_tests/rate_limit_envelope.api.spec.ts that
 *         pins the same contract.
 *   500 — synthetic test-only `/__test__/boom` (NODE_ENV=test only)
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();
const adminCreds = { username: `env_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `env_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

beforeAll(async () => {
  await prisma.$connect();

  const adminReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [
      { question: 'Q1?', answer: 'a1' },
      { question: 'Q2?', answer: 'a2' },
    ],
  });
  adminUserId = adminReg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const adminLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  const orgReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...orgCreds,
    securityQuestions: [
      { question: 'Q1?', answer: 'a1' },
      { question: 'Q2?', answer: 'a2' },
    ],
  });
  orgUserId = orgReg.body.id;
  const orgLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgCreds);
  orgToken = orgLogin.body.accessToken;
}, 15000);

afterAll(async () => {
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/** Common assertions for any error response. */
function assertEnvelope(
  res: { status: number; body: Record<string, unknown>; headers: Record<string, string> },
  expectedStatus: number,
  expectedCode?: string | RegExp,
) {
  expect(res.status).toBe(expectedStatus);

  // Header
  const headerRid = res.headers['x-request-id'];
  expect(headerRid).toBeDefined();
  expect(typeof headerRid).toBe('string');
  expect(headerRid.length).toBeGreaterThan(0);

  // Body shape
  expect(res.body.statusCode).toBe(expectedStatus);
  expect(typeof res.body.code).toBe('string');
  expect(typeof res.body.message).toBe('string');
  expect((res.body.message as string).length).toBeGreaterThan(0);
  expect(res.body.requestId).toBeDefined();
  expect(typeof res.body.requestId).toBe('string');
  expect(res.body.requestId).toBe(headerRid);

  if (expectedCode instanceof RegExp) {
    expect(String(res.body.code)).toMatch(expectedCode);
  } else if (expectedCode) {
    expect(res.body.code).toBe(expectedCode);
  }
}

describe('Error envelope — every status code carries requestId + canonical body', () => {
  it('400 VALIDATION_ERROR — POST /resources with bad type', async () => {
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: 'Bad', type: 'not_a_real_type' });
    assertEnvelope(res, 400, 'VALIDATION_ERROR');
  });

  it('401 UNAUTHORIZED — protected route without Bearer', async () => {
    const res = await request(app).get('/itineraries');
    assertEnvelope(res, 401, 'UNAUTHORIZED');
  });

  it('403 FORBIDDEN — organizer hits admin-only /audit-logs', async () => {
    const res = await request(app)
      .get('/audit-logs')
      .set('Authorization', `Bearer ${orgToken}`);
    assertEnvelope(res, 403, /FORBIDDEN/);
  });

  it('404 NOT_FOUND — unknown route', async () => {
    const res = await request(app).get('/this-route-does-not-exist');
    assertEnvelope(res, 404, 'NOT_FOUND');
  });

  it('404 NOT_FOUND — fetching a non-existent itinerary by uuid', async () => {
    const res = await request(app)
      .get(`/itineraries/${uuid()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assertEnvelope(res, 404, 'NOT_FOUND');
  });

  it('409 IDEMPOTENCY_CONFLICT — same key, different payload', async () => {
    const key = uuid();
    // First request: succeeds
    await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({ name: `Env Conflict A ${ts}`, type: 'attraction' });
    // Second request: same key, DIFFERENT body → 409
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({ name: `Env Conflict B ${ts}`, type: 'attraction' });
    assertEnvelope(res, 409, 'IDEMPOTENCY_CONFLICT');

    // Cleanup
    await prisma.resource.deleteMany({ where: { name: { startsWith: `Env Conflict A ${ts}` } } }).catch(() => {});
  });

  it('429 CHALLENGE_REQUIRED — unusual-location issuance branch', async () => {
    // Fresh user/device so this case is independent of any other test in
    // the suite. We bootstrap with cityA, then trigger an issuance from cityB.
    const creds = {
      username: `env429_chal_${ts}_${uuid().slice(0, 8)}`,
      password: 'Env429Pwd123!xx',
    };
    const fp = `env429_fp_${ts}_${uuid()}`;

    const reg = await request(app)
      .post('/auth/register')
      .set('Idempotency-Key', uuid())
      .send({
        ...creds,
        securityQuestions: [
          { question: 'Q1?', answer: 'a1' },
          { question: 'Q2?', answer: 'a2' },
        ],
      });
    expect(reg.status).toBe(201);
    const newUid: string = reg.body.id;

    try {
      const boot = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send({ ...creds, deviceFingerprint: fp, lastKnownCity: 'Seattle' });
      expect(boot.status).toBe(200);

      const res = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send({ ...creds, deviceFingerprint: fp, lastKnownCity: 'Tokyo' });
      assertEnvelope(res, 429, 'CHALLENGE_REQUIRED');
      expect(typeof res.body.challengeToken).toBe('string');
    } finally {
      await prisma.idempotencyKey
        .deleteMany({ where: { key: { startsWith: `challenge:${newUid}:` } } })
        .catch(() => {});
      await prisma.refreshToken.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.device.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.securityQuestion.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.passwordHistory.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.loginAttempt.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: newUid } }).catch(() => {});
    }
  }, 60000);

  it('429 RATE_LIMITED — 4th challenge in the rolling hour for one device', async () => {
    const creds = {
      username: `env429_lim_${ts}_${uuid().slice(0, 8)}`,
      password: 'Env429LimPwd123!xx',
    };
    const fp = `env429_lim_fp_${ts}_${uuid()}`;

    const reg = await request(app)
      .post('/auth/register')
      .set('Idempotency-Key', uuid())
      .send({
        ...creds,
        securityQuestions: [
          { question: 'Q1?', answer: 'a1' },
          { question: 'Q2?', answer: 'a2' },
        ],
      });
    expect(reg.status).toBe(201);
    const newUid: string = reg.body.id;

    try {
      const boot = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send({ ...creds, deviceFingerprint: fp, lastKnownCity: 'Seattle' });
      expect(boot.status).toBe(200);

      // Burn 3 issuances (without confirming) so the next attempt trips the
      // 3-per-hour rate limit branch.
      for (let i = 0; i < 3; i++) {
        const r = await request(app)
          .post('/auth/login')
          .set('Idempotency-Key', uuid())
          .send({ ...creds, deviceFingerprint: fp, lastKnownCity: 'Tokyo' });
        expect(r.status).toBe(429);
        expect(r.body.code).toBe('CHALLENGE_REQUIRED');
      }

      const limited = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send({ ...creds, deviceFingerprint: fp, lastKnownCity: 'Tokyo' });
      assertEnvelope(limited, 429, 'RATE_LIMITED');
      expect(limited.body.challengeToken).toBeUndefined();
      expect(String(limited.body.message)).toMatch(/too many|retry/i);
    } finally {
      await prisma.idempotencyKey
        .deleteMany({ where: { key: { startsWith: `challenge:${newUid}:` } } })
        .catch(() => {});
      await prisma.refreshToken.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.device.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.securityQuestion.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.passwordHistory.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.loginAttempt.deleteMany({ where: { userId: newUid } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: newUid } }).catch(() => {});
    }
  }, 60000);

  it('500 INTERNAL_ERROR — synthetic /__test__/boom', async () => {
    const res = await request(app).get('/__test__/boom');
    assertEnvelope(res, 500, 'INTERNAL_ERROR');
  });
});

describe('Request ID echo behaviour', () => {
  it('echoes a client-supplied X-Request-Id on a 200 success response', async () => {
    const customId = 'aaaa1111-2222-3333-4444-555555555555';
    const res = await request(app).get('/health').set('X-Request-Id', customId);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
  });

  it('echoes a client-supplied X-Request-Id on a 4xx error response (and matches requestId in body)', async () => {
    const customId = 'bbbb1111-2222-3333-4444-555555555555';
    const res = await request(app)
      .get('/itineraries/' + uuid())
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', customId);
    expect(res.headers['x-request-id']).toBe(customId);
    expect(res.body.requestId).toBe(customId);
  });

  it('still accepts the legacy X-Trace-Id header for backwards compatibility', async () => {
    const customId = 'cccc1111-2222-3333-4444-555555555555';
    const res = await request(app).get('/health').set('X-Trace-Id', customId);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
    expect(res.headers['x-trace-id']).toBe(customId);
  });

  it('generates a fresh request id when no client header is provided', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
