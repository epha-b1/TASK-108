/**
 * Coverage for `src/middleware/auth.middleware.ts` beyond what rbac.spec.ts
 * already exercises. Drives the `authMiddleware` entry points (no header,
 * invalid token, user not found, suspended user, and the happy path with
 * role resolution) so every early-return in that function is hit.
 */

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, requirePermission } from '../src/middleware/auth.middleware';
import * as rbacService from '../src/services/rbac.service';
import { getPrisma } from '../src/config/database';
import { env } from '../src/config/environment';
import { authConfig } from '../src/config/auth';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function rr(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {} as Response;
  const errs: unknown[] = [];
  const next: NextFunction = (err?: unknown) => { errs.push(err ?? null); };
  return { req, res, next, errs };
}

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

describe('authMiddleware', () => {
  it('401 when no Authorization header', async () => {
    const { req, res, next, errs } = rr();
    await authMiddleware(req, res, next);
    expect((errs[0] as any).statusCode).toBe(401);
  });

  it('401 when Authorization header not Bearer', async () => {
    const { req, res, next, errs } = rr({ authorization: 'Basic abc' });
    await authMiddleware(req, res, next);
    expect((errs[0] as any).statusCode).toBe(401);
  });

  it('passes error from verifyAccessToken through next', async () => {
    const { req, res, next, errs } = rr({ authorization: 'Bearer garbage.value.here' });
    await authMiddleware(req, res, next);
    // verifyAccessToken throws AppError(401, 'UNAUTHORIZED', ...) — passed
    // straight through to next.
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBeInstanceOf(Error);
  });

  it('401 when user row missing for valid token', async () => {
    const token = jwt.sign(
      { userId: 'u1', username: 'a', role: 'organizer' },
      env.jwtSecret,
      { algorithm: authConfig.algorithm, expiresIn: 60 },
    );
    prisma.user.findUnique.mockResolvedValue(null);
    const { req, res, next, errs } = rr({ authorization: `Bearer ${token}` });
    await authMiddleware(req, res, next);
    expect((errs[0] as any).statusCode).toBe(401);
  });

  it('403 when user status is not active', async () => {
    const token = jwt.sign(
      { userId: 'u1', username: 'a', role: 'organizer' },
      env.jwtSecret,
      { algorithm: authConfig.algorithm, expiresIn: 60 },
    );
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'suspended', role: 'organizer' });
    const { req, res, next, errs } = rr({ authorization: `Bearer ${token}` });
    await authMiddleware(req, res, next);
    expect((errs[0] as any).statusCode).toBe(403);
  });

  it('assigns canonical roleNames and primary role on success', async () => {
    const token = jwt.sign(
      { userId: 'u1', username: 'a', role: 'organizer' },
      env.jwtSecret,
      { algorithm: authConfig.algorithm, expiresIn: 60 },
    );
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active', role: 'organizer' });
    prisma.userRole.findMany.mockResolvedValue([
      { role: { name: 'admin' } },
    ]);
    const { req, res, next, errs } = rr({ authorization: `Bearer ${token}` });
    await authMiddleware(req, res, next);
    expect(errs).toEqual([null]);
    expect((req as any).user.role).toBe('admin');
    expect([...((req as any).roleNames as Set<string>)]).toEqual(['admin']);
  });

  it('primary role falls back to organizer when user_roles is non-admin', async () => {
    const token = jwt.sign(
      { userId: 'u1', username: 'a', role: 'admin' },
      env.jwtSecret,
      { algorithm: authConfig.algorithm, expiresIn: 60 },
    );
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active', role: 'admin' });
    prisma.userRole.findMany.mockResolvedValue([
      { role: { name: 'editor' } },
    ]);
    const { req, res, next, errs } = rr({ authorization: `Bearer ${token}` });
    await authMiddleware(req, res, next);
    expect(errs).toEqual([null]);
    // Non-admin canonical role collapses to 'organizer' for JWT shape.
    expect((req as any).user.role).toBe('organizer');
  });
});

describe('requirePermission — getUserPermissions fallback path', () => {
  it('fetches permissions on demand when req.permissions is unset', async () => {
    jest.spyOn(rbacService, 'getUserPermissions').mockResolvedValue(['foo:read']);
    const req = {
      user: { userId: 'u1', role: 'organizer', username: 'a' },
    } as unknown as Request;
    const next = jest.fn();
    await requirePermission('foo:read')(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(rbacService.getUserPermissions).toHaveBeenCalledWith('u1');
  });

  it('propagates getUserPermissions errors', async () => {
    jest.spyOn(rbacService, 'getUserPermissions').mockRejectedValue(new Error('db'));
    const req = {
      user: { userId: 'u1', role: 'organizer', username: 'a' },
    } as unknown as Request;
    const errs: unknown[] = [];
    const next: NextFunction = (err?: unknown) => { errs.push(err); };
    await requirePermission('foo:read')(req, {} as Response, next);
    expect(errs[0]).toBeInstanceOf(Error);
  });
});
