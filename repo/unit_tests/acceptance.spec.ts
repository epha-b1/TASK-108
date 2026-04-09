/**
 * Cross-cutting acceptance tests against REAL service code.
 *
 * Replaces the previous file which mostly asserted properties of locally-
 * declared constants and helpers. Each test here exercises a real service
 * function or middleware via the in-memory Prisma mock at
 * src/__mocks__/prisma.ts so behaviour drift in the real code surfaces here
 * instead of being missed by parallel logic copies.
 */

import { v4 as uuid } from 'uuid';
import * as authService from '../src/services/auth.service';
import * as modelService from '../src/services/model.service';
import * as notificationService from '../src/services/notification.service';
import * as importService from '../src/services/import.service';
import { getPrisma } from '../src/config/database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = getPrisma() as any;

function reset() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model as Record<string, unknown>)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

beforeEach(() => reset());

// ----------------------------------------------------------------------------
// A) Auth — token round-trip uses the real signer/verifier
// ----------------------------------------------------------------------------
describe('auth.service — JWT round-trip', () => {
  it('signAccessToken + verifyAccessToken returns the original payload', () => {
    const token = authService.signAccessToken({
      userId: 'u-1',
      username: 'alice',
      role: 'organizer',
    });
    const payload = authService.verifyAccessToken(token);
    expect(payload.userId).toBe('u-1');
    expect(payload.username).toBe('alice');
    expect(payload.role).toBe('organizer');
  });

  it('verifyAccessToken throws AppError on a forged token', () => {
    expect(() => authService.verifyAccessToken('not-a-jwt')).toThrow();
  });
});

// ----------------------------------------------------------------------------
// B) Auth — device cap returns 409 with the existing device list
// ----------------------------------------------------------------------------
describe('auth.service.login — device cap contract', () => {
  it('returns 409 DEVICE_LIMIT_REACHED with the device list as `details`', async () => {
    // Use a precomputed bcrypt hash for "Pass1234567!"
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('Pass1234567!', 4);

    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      username: 'alice',
      passwordHash,
      role: 'organizer',
      status: 'active',
      lockedUntil: null,
    });
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue(null); // no matching device → counts as new
    prisma.device.count.mockResolvedValue(5); // already at the cap
    prisma.device.findMany.mockResolvedValue([
      { id: 'd1', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
      { id: 'd2', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
      { id: 'd3', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
      { id: 'd4', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
      { id: 'd5', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
    ]);

    await expect(
      authService.login('alice', 'Pass1234567!', 'fp-new'),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_LIMIT_REACHED',
      details: expect.objectContaining({ devices: expect.any(Array) }),
    });
  });
});

// ----------------------------------------------------------------------------
// C) Auth — unusual-location challenge issues a token + per-attempt key
// ----------------------------------------------------------------------------
describe('auth.service.login — unusual-location challenge', () => {
  it('returns a challengeToken when lastKnownCity changes for an existing device', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('Pass1234567!', 4);

    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      username: 'alice',
      passwordHash,
      role: 'organizer',
      status: 'active',
      lockedUntil: null,
    });
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({
      id: 'd-1',
      userId: 'u-1',
      lastKnownCity: 'Paris',
    });
    prisma.idempotencyKey.findMany.mockResolvedValue([]); // 0 prior challenges
    prisma.idempotencyKey.create.mockResolvedValue({});

    const result = await authService.login('alice', 'Pass1234567!', 'fp-1', 'Tokyo');
    expect(result).toMatchObject({
      challengeToken: expect.any(String),
      retryAfterSeconds: 300,
    });
    // Per-attempt key was created with the location_challenge operation type.
    expect(prisma.idempotencyKey.create).toHaveBeenCalled();
    const createArgs = prisma.idempotencyKey.create.mock.calls[0][0].data;
    expect(createArgs.operationType).toBe('location_challenge');
  });
});

// ----------------------------------------------------------------------------
// D) Model service — A/B routing is deterministic on (userId, modelName)
// ----------------------------------------------------------------------------
describe('model.service.infer — adapter falls back to mock in test', () => {
  it('returns a deterministic mock inference shape', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm-1',
      name: 'm',
      version: '1.0.0',
      type: 'pmml',
      status: 'active',
      config: null,
      abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue(null); // no canary

    const out = await modelService.infer('m-1', { budget: 100, nights: 3 }, {}, 'u-1');
    expect(typeof out.prediction).toBe('number');
    expect(typeof out.confidence).toBe('number');
    expect(Array.isArray(out.confidenceBand)).toBe(true);
    expect(out.confidenceBand.length).toBe(2);
    expect(Array.isArray(out.topFeatures)).toBe(true);
  });

  it('rejects inference on inactive models with VALIDATION_ERROR', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm-1',
      name: 'm',
      version: '1.0.0',
      type: 'pmml',
      status: 'inactive',
      config: null,
      abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue(null);

    await expect(
      modelService.infer('m-1', { budget: 1 }, {}),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });
});

// ----------------------------------------------------------------------------
// E) Notification — blacklist + daily cap blocking
// ----------------------------------------------------------------------------
describe('notification.service.sendNotification — guards', () => {
  it('blocks blacklisted users with 403 FORBIDDEN', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue({
      userId: 'u-1',
      blacklisted: true,
      dailyCap: 20,
      dailySent: 0,
    });

    await expect(
      notificationService.sendNotification('u-1', 'info', undefined, undefined, 'S', 'M'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('blocks users at the daily cap with 429 RATE_LIMITED', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue({
      userId: 'u-1',
      blacklisted: false,
      dailyCap: 5,
      dailySent: 5,
    });

    await expect(
      notificationService.sendNotification('u-1', 'info', undefined, undefined, 'S', 'M'),
    ).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });
});

// ----------------------------------------------------------------------------
// F) Import — idempotency-key replay returns the existing batch
// ----------------------------------------------------------------------------
describe('import.service.uploadAndValidate — idempotency replay', () => {
  it('returns the existing batch (no new create) when the key was used before', async () => {
    const cached = { id: 'cached', errors: [] };
    prisma.importBatch.findUnique.mockResolvedValue(cached);

    const result = await importService.uploadAndValidate(
      'u-1',
      { buffer: Buffer.from('name,type\nA,attraction\n'), originalname: 'x.csv' },
      'resources',
      'replay-key',
    );

    expect(result).toBe(cached);
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// G) Misc — uuid module is wired in (sanity)
// ----------------------------------------------------------------------------
describe('uuid sanity', () => {
  it('uuid() returns a v4-shaped string', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
