/**
 * 429 envelope + request-id consistency tests.
 *
 * The unusual-location challenge flow has TWO branches that both return HTTP
 * 429, and historically only the rate-limited branch went through the global
 * AppError handler. The challenge-issuance branch wrote a bare
 * `{ challengeToken, retryAfterSeconds, message }` body, which broke the
 * "every error response carries the canonical envelope" contract that
 * envelope.api.spec.ts asserts on every other status code.
 *
 * This file pins both 429 branches:
 *
 *   1. CHALLENGE_REQUIRED issuance — has `challengeToken` AND canonical
 *      envelope fields (`statusCode`, `code='CHALLENGE_REQUIRED'`, `message`,
 *      `requestId` matching `X-Request-Id`).
 *
 *   2. RATE_LIMITED branch — no `challengeToken`, canonical envelope with
 *      `code='RATE_LIMITED'`, message mentions retry timing, requestId
 *      matches header.
 *
 * Each branch is exercised against a fresh user/device pair so the suite is
 * deterministic and order-independent.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const TS = Date.now();

const cityA = 'Seattle';
const cityB = 'Tokyo';

async function cleanupUser(userId: string | undefined): Promise<void> {
  if (!userId) return;
  await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.device.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.securityQuestion.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.passwordHistory.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.loginAttempt.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
}

async function cleanupChallengeKeysFor(userId: string): Promise<void> {
  await prisma.idempotencyKey
    .deleteMany({ where: { key: { startsWith: `challenge:${userId}:` } } })
    .catch(() => {});
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Common envelope assertions for ANY 429 response from the unusual-location
 * flow. Pinned to a single helper so the two branches can't drift.
 */
function assert429Envelope(
  res: { status: number; body: Record<string, unknown>; headers: Record<string, string> },
  expectedCode: 'CHALLENGE_REQUIRED' | 'RATE_LIMITED',
) {
  expect(res.status).toBe(429);

  // Header MUST be present and the body's requestId MUST equal it.
  const headerRid = res.headers['x-request-id'];
  expect(headerRid).toBeDefined();
  expect(typeof headerRid).toBe('string');
  expect(headerRid.length).toBeGreaterThan(0);

  expect(res.body.statusCode).toBe(429);
  expect(res.body.code).toBe(expectedCode);
  expect(typeof res.body.message).toBe('string');
  expect((res.body.message as string).length).toBeGreaterThan(0);

  expect(res.body.requestId).toBeDefined();
  expect(typeof res.body.requestId).toBe('string');
  expect(res.body.requestId).toBe(headerRid);

  // Deprecated alias remains identical until removal — see README deprecation table.
  expect(res.body.traceId).toBe(res.body.requestId);
}

describe('429 envelope — CHALLENGE_REQUIRED issuance branch', () => {
  const creds = {
    username: `rl_env_chal_${TS}_${uuid().slice(0, 8)}`,
    password: 'EnvChalPwd123!xx',
  };
  let userId: string;
  const fp = `rl_env_fp_${TS}_${uuid()}`;

  beforeAll(async () => {
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
    userId = reg.body.id;

    // Bootstrap: register the device + last-known city.
    const boot = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityA });
    expect(boot.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    await cleanupChallengeKeysFor(userId);
    await cleanupUser(userId);
  });

  it('issues a challenge token wrapped in the canonical envelope', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityB });

    assert429Envelope(res, 'CHALLENGE_REQUIRED');

    // Issuance-specific extras: token + retry-after at top level so existing
    // clients keep working unchanged.
    expect(typeof res.body.challengeToken).toBe('string');
    expect((res.body.challengeToken as string).length).toBeGreaterThan(0);
    expect(typeof res.body.retryAfterSeconds).toBe('number');
    expect(res.body.message).toMatch(/unusual location/i);
  }, 30000);

  it('echoes a client-supplied X-Request-Id on the 429 issuance response', async () => {
    const customId = '11111111-aaaa-bbbb-cccc-222222222222';
    const res = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .set('X-Request-Id', customId)
      .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityB });

    assert429Envelope(res, 'CHALLENGE_REQUIRED');
    expect(res.headers['x-request-id']).toBe(customId);
    expect(res.body.requestId).toBe(customId);
  }, 30000);
});

describe('429 envelope — RATE_LIMITED branch (4th challenge in rolling hour)', () => {
  const creds = {
    username: `rl_env_lim_${TS}_${uuid().slice(0, 8)}`,
    password: 'EnvRlPwd123!xx',
  };
  let userId: string;
  const fp = `rl_env_lim_fp_${TS}_${uuid()}`;

  beforeAll(async () => {
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
    userId = reg.body.id;

    // Bootstrap.
    const boot = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityA });
    expect(boot.status).toBe(200);
  }, 30000);

  afterAll(async () => {
    await cleanupChallengeKeysFor(userId);
    await cleanupUser(userId);
  });

  it('returns RATE_LIMITED with canonical envelope after 3 challenge issuances', async () => {
    // Burn 3 issuances by hitting login from cityB three times (without
    // confirming any of them, so the device's lastKnownCity stays cityA).
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityB });
      expect(r.status).toBe(429);
      // Each issuance should still satisfy the canonical envelope.
      assert429Envelope(r, 'CHALLENGE_REQUIRED');
      expect(typeof r.body.challengeToken).toBe('string');
    }

    // 4th attempt within the rolling hour: rate-limited branch.
    const limited = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send({ ...creds, deviceFingerprint: fp, lastKnownCity: cityB });

    assert429Envelope(limited, 'RATE_LIMITED');
    // Rate-limited branch must NOT carry challengeToken at the top level —
    // that's how clients tell the two branches apart.
    expect(limited.body.challengeToken).toBeUndefined();
    expect(String(limited.body.message)).toMatch(/too many|retry/i);
  }, 60000);
});
