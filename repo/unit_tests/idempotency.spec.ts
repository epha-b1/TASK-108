/**
 * Coverage for `src/middleware/idempotency.middleware.ts`.
 *
 * This middleware has a dense branching table (mutating-method guard,
 * bearer token verification, cross-actor replay protection, fingerprint
 * mismatch, cached replay, reserved-but-still-processing race handler,
 * and interception of `res.json` so the eventual response is stored).
 * Each branch is exercised below with mocked Prisma.
 */

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware } from '../src/middleware/idempotency.middleware';
import { getPrisma } from '../src/config/database';
import { env } from '../src/config/environment';
import { authConfig } from '../src/config/auth';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function rr(over: Partial<Request> = {}) {
  const jsonCalls: { status: number; body: unknown }[] = [];
  const state = { statusCode: 200 };
  const req = {
    method: 'POST',
    originalUrl: '/resources',
    headers: {},
    body: {},
    ...over,
  } as unknown as Request;
  const resObj: any = {
    statusCode: 200,
    status(c: number) { resObj.statusCode = c; state.statusCode = c; return resObj; },
    json(body: unknown) { jsonCalls.push({ status: resObj.statusCode, body }); return resObj; },
    setHeader() {},
  };
  const res = resObj as Response;
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  return { req, res, next, jsonCalls, state, wasNext: () => nextCalled };
}

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

function validBearer(userId: string): string {
  return jwt.sign({ userId }, env.jwtSecret, { algorithm: authConfig.algorithm });
}

describe('idempotencyMiddleware — gates & actor resolution', () => {
  it('passes GET through untouched (non-mutating method)', async () => {
    const { req, res, next, wasNext } = rr({ method: 'GET' });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });

  it('passes through when bearer signature is invalid (401 comes later from authMiddleware)', async () => {
    const { req, res, next, wasNext } = rr({
      headers: { authorization: 'Bearer bogus.token.here' } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });

  it('anonymous mutating request without key returns 400 envelope', async () => {
    const { req, res, jsonCalls, state } = rr();
    await idempotencyMiddleware(req, res, () => {});
    expect(state.statusCode).toBe(400);
    expect((jsonCalls[0].body as any).code).toBe('MISSING_IDEMPOTENCY_KEY');
  });
});

describe('idempotencyMiddleware — cross-actor protection', () => {
  it('returns 401 when anonymous request presents a key belonging to a verified actor', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: 'k-1',
      expiresAt: new Date(Date.now() + 60_000),
      responseBody: { _actor: 'user-A', _fingerprint: 'fp', _statusCode: 200, _body: { ok: true } },
    });
    const { req, res, state, jsonCalls } = rr({
      headers: { 'idempotency-key': 'k-1' } as any,
    });
    await idempotencyMiddleware(req, res, () => {});
    expect(state.statusCode).toBe(401);
    expect((jsonCalls[0].body as any).code).toBe('UNAUTHORIZED');
  });

  it('lets a different verified actor run fresh rather than replay another user\'s cache', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: 'k-2',
      expiresAt: new Date(Date.now() + 60_000),
      responseBody: { _actor: 'user-A', _fingerprint: 'fp', _statusCode: 200, _body: {} },
    });
    const { req, res, next, wasNext } = rr({
      headers: {
        authorization: `Bearer ${validBearer('user-B')}`,
        'idempotency-key': 'k-2',
      } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });
});

describe('idempotencyMiddleware — fingerprint mismatch & replay', () => {
  it('409 when fingerprint differs from cached one', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: 'k-3',
      expiresAt: new Date(Date.now() + 60_000),
      responseBody: { _actor: 'anonymous', _fingerprint: 'DIFFERENT', _statusCode: 200, _body: {} },
    });
    const { req, res, state, jsonCalls } = rr({
      headers: { 'idempotency-key': 'k-3' } as any,
      body: { some: 'payload' },
    });
    await idempotencyMiddleware(req, res, () => {});
    expect(state.statusCode).toBe(409);
    expect((jsonCalls[0].body as any).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('replays cached response when key+fingerprint match and status > 0', async () => {
    // Craft a request whose fingerprint will match what we stash.
    const { req, res, state, jsonCalls } = rr({
      headers: { 'idempotency-key': 'k-replay' } as any,
      body: {},
    });
    // First call exposes the fingerprint logic — we stub findUnique to return
    // a "completed" entry whose actor is anonymous (matches the request) and
    // whose fingerprint is whatever the middleware computes.
    prisma.idempotencyKey.findUnique.mockImplementation(async () => ({
      key: 'k-replay',
      expiresAt: new Date(Date.now() + 60_000),
      responseBody: {
        _actor: 'anonymous',
        // The fingerprint check is "set and different"; keeping it absent
        // falls through to the statusCode branch instead.
        _statusCode: 201,
        _body: { created: true },
      },
    }));
    await idempotencyMiddleware(req, res, () => {});
    expect(state.statusCode).toBe(201);
    expect((jsonCalls[0].body as any).created).toBe(true);
  });

  it('reserved-but-still-processing → brief wait + replay when refreshed entry completes', async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce({
        key: 'k-race',
        expiresAt: new Date(Date.now() + 60_000),
        responseBody: { _actor: 'anonymous', _statusCode: 0, _body: null },
      })
      .mockResolvedValueOnce({
        key: 'k-race',
        expiresAt: new Date(Date.now() + 60_000),
        responseBody: { _actor: 'anonymous', _statusCode: 200, _body: { ok: true } },
      });
    const { req, res, state, jsonCalls } = rr({
      headers: { 'idempotency-key': 'k-race' } as any,
    });
    await idempotencyMiddleware(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect((jsonCalls[0].body as any).ok).toBe(true);
  });

  it('reserved-but-still-processing → still pending → falls through to fresh execution', async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce({
        key: 'k-still',
        expiresAt: new Date(Date.now() + 60_000),
        responseBody: { _actor: 'anonymous', _statusCode: 0, _body: null },
      })
      .mockResolvedValueOnce({
        key: 'k-still',
        expiresAt: new Date(Date.now() + 60_000),
        responseBody: { _actor: 'anonymous', _statusCode: 0, _body: null },
      });
    prisma.idempotencyKey.upsert.mockResolvedValue({ key: 'k-still' });
    const { req, res, next, wasNext } = rr({
      headers: { 'idempotency-key': 'k-still' } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });

  it('reserved entry whose refresh returns null → falls through', async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce({
        key: 'k-null',
        expiresAt: new Date(Date.now() + 60_000),
        responseBody: { _actor: 'anonymous', _statusCode: 0, _body: null },
      })
      .mockResolvedValueOnce(null);
    prisma.idempotencyKey.upsert.mockResolvedValue({ key: 'k-null' });
    const { req, res, next, wasNext } = rr({
      headers: { 'idempotency-key': 'k-null' } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });
});

describe('idempotencyMiddleware — reservation + response interception', () => {
  it('upserts the reservation record and intercepts res.json', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.upsert.mockResolvedValue({ key: 'k-fresh' });
    prisma.idempotencyKey.update.mockResolvedValue({ key: 'k-fresh' });
    const { req, res, next, wasNext } = rr({
      headers: { 'idempotency-key': 'k-fresh' } as any,
      body: { a: 1 },
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
    // Intercepted res.json should call the stored update, with redacted body.
    res.status(201);
    res.json({ accessToken: 'SECRET', ok: true });
    // Fire-and-forget: wait a tick so the update promise resolves.
    await new Promise((r) => setImmediate(r));
    expect(prisma.idempotencyKey.update).toHaveBeenCalled();
    const record = (prisma.idempotencyKey.update.mock.calls[0][0] as any).data.responseBody;
    expect(record._body.accessToken).toBe('[REDACTED]');
    expect(record._body.ok).toBe(true);
  });

  it('swallows update errors from intercepted res.json', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.upsert.mockResolvedValue({ key: 'k-err' });
    prisma.idempotencyKey.update.mockRejectedValue(new Error('boom'));
    const { req, res, next } = rr({
      headers: { 'idempotency-key': 'k-err' } as any,
      body: {},
    });
    await idempotencyMiddleware(req, res, next);
    res.json({ ok: true });
    await new Promise((r) => setImmediate(r));
    // Nothing to assert beyond "no unhandled rejection"; test passes when
    // the process does not crash.
    expect(prisma.idempotencyKey.update).toHaveBeenCalled();
  });

  it('catches prisma errors around reservation and falls through to next()', async () => {
    prisma.idempotencyKey.findUnique.mockRejectedValue(new Error('db down'));
    const { req, res, next, wasNext } = rr({
      headers: { 'idempotency-key': 'k-catch' } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });

  it('expired record (expiresAt in past) is treated as absent', async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: 'k-expired',
      expiresAt: new Date(Date.now() - 1_000),
      responseBody: { _actor: 'anonymous', _statusCode: 200, _body: { stale: true } },
    });
    prisma.idempotencyKey.upsert.mockResolvedValue({ key: 'k-expired' });
    const { req, res, next, wasNext } = rr({
      headers: { 'idempotency-key': 'k-expired' } as any,
    });
    await idempotencyMiddleware(req, res, next);
    expect(wasNext()).toBe(true);
  });
});
