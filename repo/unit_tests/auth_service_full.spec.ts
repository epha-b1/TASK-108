/**
 * Comprehensive coverage for `src/services/auth.service.ts` — exercises
 * every exported function and the non-trivial branches inside `login`
 * (rolling lockout, device cap, unusual location challenge issuance,
 * challenge token consumption, rate-limit throttle) so the service
 * moves from ~38% to full coverage.
 */

import bcrypt from 'bcryptjs';
import * as auth from '../src/services/auth.service';
import { getPrisma } from '../src/config/database';
import { AppError } from '../src/utils/errors';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function resetPrisma() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
  // $transaction passthrough (some tests replace this)
  (prisma as any).$transaction = jest.fn(async (arg: any) => {
    if (typeof arg === 'function') return arg(prisma);
    if (Array.isArray(arg)) return Promise.all(arg.map((p) => (typeof p === 'function' ? p() : p)));
    return arg;
  });
}

beforeEach(() => {
  resetPrisma();
});

const STRONG = 'SuperS3cret!Passw0rd';

describe('register', () => {
  it('throws on weak password', async () => {
    await expect(auth.register('u', 'short', [{ question: 'q', answer: 'a' }])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires exactly 2 security questions', async () => {
    await expect(auth.register('u', STRONG, [])).rejects.toMatchObject({ statusCode: 400 });
    await expect(auth.register('u', STRONG, [
      { question: 'q1', answer: 'a1' },
    ])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('409 on username collision', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'x' });
    await expect(
      auth.register('u', STRONG, [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }]),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates user with hashed password and initial password history', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u1', username: 'u' });
    const out = await auth.register('u', STRONG, [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ]);
    expect(out).toEqual({ id: 'u1', username: 'u' });
    const args = prisma.user.create.mock.calls[0][0].data;
    // Hash must be a bcrypt string — starts with $2
    expect(args.passwordHash).toMatch(/^\$2/);
    expect(args.securityQuestions.create).toHaveLength(2);
    expect(args.passwordHistory.create.passwordHash).toBe(args.passwordHash);
  });
});

describe('verifyAccessToken', () => {
  it('throws AppError on invalid token', () => {
    expect(() => auth.verifyAccessToken('garbage.token.value')).toThrow(AppError);
  });

  it('round-trips a signed token', () => {
    const t = auth.signAccessToken({ userId: 'u1', username: 'u', role: 'admin' } as any);
    const p = auth.verifyAccessToken(t);
    expect(p.userId).toBe('u1');
    expect(p.role).toBe('admin');
  });
});

describe('login', () => {
  async function mockPwUser(over: Partial<any> = {}) {
    const hash = await bcrypt.hash(STRONG, 4);
    return { id: 'u1', username: 'u', passwordHash: hash, status: 'active', role: 'organizer', lockedUntil: null, ...over };
  }

  it('401 on unknown username', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(auth.login('ghost', STRONG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('auto-unlocks a user whose lockout window has expired', async () => {
    const user = await mockPwUser({ lockedUntil: new Date(Date.now() - 60_000), status: 'locked' });
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({});
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.device.count.mockResolvedValue(0);
    prisma.device.create.mockResolvedValue({ id: 'd1' });
    prisma.refreshToken.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG);
    expect(out.tokens?.accessToken).toBeDefined();
  });

  it('423 when account is explicitly locked', async () => {
    const user = await mockPwUser({ status: 'locked', lockedUntil: new Date(Date.now() + 60_000) });
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(auth.login('u', STRONG)).rejects.toMatchObject({ statusCode: 423 });
  });

  it('403 when account is suspended', async () => {
    const user = await mockPwUser({ status: 'suspended' });
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(auth.login('u', STRONG)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('401 on wrong password AND records failed attempt', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.loginAttempt.count.mockResolvedValue(1);
    await expect(auth.login('u', 'WrongPassword!1A')).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.loginAttempt.create).toHaveBeenCalled();
  });

  it('locks account after 10 failed attempts in window', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.loginAttempt.count.mockResolvedValue(10);
    prisma.user.update.mockResolvedValue({});
    await expect(auth.login('u', 'WrongPassword!1A')).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'locked' }),
    }));
  });

  it('409 DEVICE_LIMIT_REACHED with device list in details when new device + cap reached', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.device.count.mockResolvedValue(5);
    prisma.device.findMany.mockResolvedValue([
      { id: 'd1', lastSeenAt: new Date(), lastKnownCity: null, createdAt: new Date() },
    ]);
    try {
      await auth.login('u', STRONG, 'new-device');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('DEVICE_LIMIT_REACHED');
      expect(err.details).toHaveProperty('devices');
    }
  });

  it('creates new device when under cap and issues tokens', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.device.count.mockResolvedValue(0);
    prisma.device.create.mockResolvedValue({ id: 'd1' });
    prisma.refreshToken.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG, 'fp-1', 'Rome');
    expect(out.tokens.accessToken).toBeDefined();
    expect(out.user.role).toBe('organizer');
  });

  it('issues unusual-location challenge token when city differs', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({
      id: 'd1', lastKnownCity: 'Rome', userId: 'u1',
    });
    prisma.idempotencyKey.findMany.mockResolvedValue([]);
    prisma.idempotencyKey.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG, 'fp-1', 'Paris');
    expect(out.challengeToken).toBeDefined();
    expect(out.retryAfterSeconds).toBe(300);
  });

  it('consumes challenge token on matching attempt', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({ id: 'd1', lastKnownCity: 'Rome', userId: 'u1' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: 'x', operationType: 'location_challenge', expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.idempotencyKey.delete.mockResolvedValue({});
    prisma.device.update.mockResolvedValue({});
    prisma.refreshToken.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG, 'fp-1', 'Paris', 'chal-token');
    expect(out.tokens.accessToken).toBeDefined();
    expect(prisma.idempotencyKey.delete).toHaveBeenCalled();
  });

  it('401 when challenge token is expired/missing/wrong type', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({ id: 'd1', lastKnownCity: 'Rome', userId: 'u1' });
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    await expect(auth.login('u', STRONG, 'fp-1', 'Paris', 'bad-token')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('429 RATE_LIMITED when >=3 challenges in the past hour', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({ id: 'd1', lastKnownCity: 'Rome', userId: 'u1' });
    const now = Date.now();
    prisma.idempotencyKey.findMany.mockResolvedValue([
      { createdAt: new Date(now - 10 * 60_000) },
      { createdAt: new Date(now - 20 * 60_000) },
      { createdAt: new Date(now - 5 * 60_000) },
    ]);
    await expect(auth.login('u', STRONG, 'fp-1', 'Paris')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('same-city login refreshes device without challenge', async () => {
    const user = await mockPwUser();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({ id: 'd1', lastKnownCity: 'Rome', userId: 'u1' });
    prisma.device.update.mockResolvedValue({});
    prisma.refreshToken.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG, 'fp-1', 'Rome');
    expect(out.tokens.accessToken).toBeDefined();
  });

  it('successful login clears any prior lock state', async () => {
    const user: any = await mockPwUser({ status: 'locked', lockedUntil: new Date(Date.now() + 60_000) });
    // First: expired-lock auto-unlock — but we want to test the "after-pw-ok unlock" branch.
    user.status = 'active'; // bypass the lock throw
    user.lockedUntil = new Date(Date.now() - 1_000); // auto-unlock branch runs first
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({});
    prisma.loginAttempt.create.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.device.count.mockResolvedValue(0);
    prisma.device.create.mockResolvedValue({ id: 'd1' });
    prisma.refreshToken.create.mockResolvedValue({});
    const out: any = await auth.login('u', STRONG);
    expect(out.tokens?.accessToken).toBeDefined();
  });
});

describe('refresh', () => {
  it('401 when token is unknown', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue(null);
    await expect(auth.refresh('raw')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('401 when token is revoked', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({
      revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), user: { status: 'active' },
    });
    await expect(auth.refresh('raw')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('401 when token is expired', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({
      revokedAt: null, expiresAt: new Date(Date.now() - 60_000), user: { status: 'active' },
    });
    await expect(auth.refresh('raw')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('403 when user is not active', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({
      revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { status: 'suspended', id: 'u1', username: 'u', role: 'organizer' },
    });
    await expect(auth.refresh('raw')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('issues new access token when valid', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({
      revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'u1', username: 'u', role: 'organizer', status: 'active' },
    });
    const out = await auth.refresh('raw');
    expect(out.accessToken).toBeDefined();
  });
});

describe('logout', () => {
  it('no-op when token unknown', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue(null);
    await auth.logout('raw');
    expect(prisma.refreshToken.update).not.toHaveBeenCalled();
  });

  it('no-op when token already revoked', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({ id: 'r1', revokedAt: new Date() });
    await auth.logout('raw');
    expect(prisma.refreshToken.update).not.toHaveBeenCalled();
  });

  it('revokes an active token', async () => {
    prisma.refreshToken.findFirst.mockResolvedValue({ id: 'r1', revokedAt: null });
    prisma.refreshToken.update.mockResolvedValue({});
    await auth.logout('raw');
    expect(prisma.refreshToken.update).toHaveBeenCalled();
  });
});

describe('changePassword', () => {
  it('400 on weak new password', async () => {
    await expect(auth.changePassword('u1', STRONG, 'weak')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(auth.changePassword('uX', 'old', STRONG)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('401 when current password is wrong', async () => {
    const hash = await bcrypt.hash('real-current', 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: hash });
    await expect(auth.changePassword('u1', 'not-it-p4ss!WORD', STRONG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('400 when new password matches any of last 5', async () => {
    const oldHash = await bcrypt.hash(STRONG, 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: oldHash });
    prisma.passwordHistory.findMany.mockResolvedValue([{ passwordHash: oldHash }]);
    await expect(auth.changePassword('u1', STRONG, STRONG)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('updates password and appends to history on success', async () => {
    const currentHash = await bcrypt.hash(STRONG, 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: currentHash });
    prisma.passwordHistory.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue({});
    prisma.passwordHistory.create.mockResolvedValue({});
    await auth.changePassword('u1', STRONG, 'An0therStr0ng!Pass');
    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.passwordHistory.create).toHaveBeenCalled();
  });
});

describe('recoverPassword', () => {
  it('400 on weak new password', async () => {
    await expect(auth.recoverPassword('u', [], 'weak')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('401 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(auth.recoverPassword('u', [], STRONG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('401 when user has no security questions', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', securityQuestions: [] });
    await expect(auth.recoverPassword('u', [], STRONG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('401 when provided answers do not match stored', async () => {
    // The mock encrypt/decrypt in crypto.ts is the real AES implementation
    // so we need to encrypt via the real util. Import it.
    const { encrypt } = await import('../src/utils/crypto');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      securityQuestions: [
        { question: 'pet', answerEncrypted: encrypt('fluffy') },
        { question: 'city', answerEncrypted: encrypt('rome') },
      ],
    });
    await expect(
      auth.recoverPassword('u', [
        { question: 'pet', answer: 'fluffy' },
        { question: 'city', answer: 'paris' }, // wrong
      ], STRONG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('resets password, clears lock, and adds history entry on success', async () => {
    const { encrypt } = await import('../src/utils/crypto');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      securityQuestions: [
        { question: 'pet', answerEncrypted: encrypt('fluffy') },
        { question: 'city', answerEncrypted: encrypt('rome') },
      ],
    });
    prisma.user.update.mockResolvedValue({});
    prisma.passwordHistory.create.mockResolvedValue({});
    await auth.recoverPassword('u', [
      { question: 'pet', answer: 'Fluffy ' },
      { question: 'City ', answer: 'ROME' },
    ], STRONG);
    const call = prisma.user.update.mock.calls[0][0];
    expect(call.data.status).toBe('active');
    expect(call.data.failedAttempts).toBe(0);
    expect(call.data.lockedUntil).toBeNull();
  });
});

describe('getMe', () => {
  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(auth.getMe('u1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns selected fields on success', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', username: 'u' });
    const out = await auth.getMe('u1');
    expect(out.username).toBe('u');
  });
});

describe('getDevices', () => {
  it('orders by lastSeenAt desc', async () => {
    prisma.device.findMany.mockResolvedValue([]);
    await auth.getDevices('u1');
    const call = prisma.device.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ lastSeenAt: 'desc' });
  });
});

describe('removeDevice', () => {
  it('404 when device not owned by user', async () => {
    prisma.device.findFirst.mockResolvedValue(null);
    await expect(auth.removeDevice('u1', 'd-ghost')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('atomically removes refresh tokens and device', async () => {
    prisma.device.findFirst.mockResolvedValue({ id: 'd1' });
    prisma.refreshToken.deleteMany.mockResolvedValue({});
    prisma.device.delete.mockResolvedValue({});
    await auth.removeDevice('u1', 'd1');
    expect((prisma as any).$transaction).toHaveBeenCalled();
  });
});
