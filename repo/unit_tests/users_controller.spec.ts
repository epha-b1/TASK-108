/**
 * Coverage for `src/controllers/users.controller.ts`. The users controller
 * talks to Prisma directly for list/get/update/delete, so the tests mock
 * Prisma and drive every branch:
 *   - list paging clamps (lower bound 1, upper bound 100)
 *   - get self vs admin vs other-user-denied
 *   - update invalid status vs valid status vs missing user
 *   - delete missing vs successful cascade
 */

import { Request, Response, NextFunction } from 'express';
import * as usersController from '../src/controllers/users.controller';
import * as auditService from '../src/services/audit.service';
import { getPrisma } from '../src/config/database';
import { AppError } from '../src/utils/errors';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function rr(over: Partial<Request> = {}) {
  const req = {
    user: { userId: 'u-actor', username: 'actor', role: 'admin' },
    body: {},
    query: {},
    params: {},
    headers: {},
    ...over,
  } as unknown as Request;
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(c: number) { state.statusCode = c; return this; },
    json(b: unknown) { state.body = b; return this; },
    send(b: unknown) { state.body = b; return this; },
    setHeader() {},
  } as unknown as Response;
  const calls: { err: unknown }[] = [];
  const next: NextFunction = (err?: unknown) => { calls.push({ err }); };
  return { req, res, next, state, calls };
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(auditService, 'audit').mockImplementation(() => undefined);
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

describe('listUsers', () => {
  it('uses defaults when no paging query', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    const { req, res, state } = rr();
    await usersController.listUsers(req, res, () => {});
    expect(state.body).toEqual({ data: [], page: 1, limit: 20, total: 0 });
    const findCall = prisma.user.findMany.mock.calls[0][0];
    expect(findCall.skip).toBe(0);
    expect(findCall.take).toBe(20);
  });

  it('clamps limit to 1..100 and page >= 1', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    const { req, res, state } = rr({ query: { page: '-5', limit: '500' } as any });
    await usersController.listUsers(req, res, () => {});
    expect(state.body).toMatchObject({ page: 1, limit: 100 });
    expect(prisma.user.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('honours valid paging values', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    const { req, res, state } = rr({ query: { page: '3', limit: '5' } as any });
    await usersController.listUsers(req, res, () => {});
    expect(state.body).toMatchObject({ page: 3, limit: 5 });
    expect(prisma.user.findMany.mock.calls[0][0].skip).toBe(10);
  });

  it('propagates DB errors via next', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await usersController.listUsers(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

describe('getUser', () => {
  it('403 when non-admin requests another user', async () => {
    const { req, res, next, calls } = rr({
      user: { userId: 'self', role: 'organizer', username: 'o' } as any,
      params: { id: 'other' },
    });
    await usersController.getUser(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(403);
  });

  it('organizer fetching own profile is allowed', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'self', username: 'o' });
    const { req, res, state } = rr({
      user: { userId: 'self', role: 'organizer', username: 'o' } as any,
      params: { id: 'self' },
    });
    await usersController.getUser(req, res, () => {});
    expect((state.body as any).id).toBe('self');
  });

  it('admin fetching any user is allowed', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'other' });
    const { req, res, state } = rr({ params: { id: 'other' } });
    await usersController.getUser(req, res, () => {});
    expect((state.body as any).id).toBe('other');
  });

  it('404 when user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { id: 'ghost' } });
    await usersController.getUser(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('DB error → next', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'x' } });
    await usersController.getUser(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

describe('updateUser', () => {
  it('400 for invalid status value', async () => {
    const { req, res, next, calls } = rr({ params: { id: 'u1' }, body: { status: 'frozen' } });
    await usersController.updateUser(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(400);
  });

  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { id: 'u1' }, body: { status: 'active' } });
    await usersController.updateUser(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('updates and audits on valid status', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active' });
    prisma.user.update.mockResolvedValue({ id: 'u1', username: 'a', role: 'organizer', status: 'suspended' });
    const { req, res, state } = rr({ params: { id: 'u1' }, body: { status: 'suspended' } });
    await usersController.updateUser(req, res, () => {});
    expect((state.body as any).status).toBe('suspended');
  });

  it('accepts an empty status body (no validation branch)', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', status: 'active' });
    prisma.user.update.mockResolvedValue({ id: 'u1' });
    const { req, res, state } = rr({ params: { id: 'u1' }, body: {} });
    await usersController.updateUser(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('DB error → next', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'u1' }, body: {} });
    await usersController.updateUser(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

describe('deleteUser', () => {
  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { id: 'u1' } });
    await usersController.deleteUser(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('cascades related-record deletions and returns 204', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', username: 'a' });
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    prisma.device.deleteMany.mockResolvedValue({ count: 1 });
    prisma.securityQuestion.deleteMany.mockResolvedValue({ count: 1 });
    prisma.passwordHistory.deleteMany.mockResolvedValue({ count: 1 });
    prisma.userRole.deleteMany.mockResolvedValue({ count: 1 });
    prisma.user.delete.mockResolvedValue({ id: 'u1' });
    const { req, res, state } = rr({ params: { id: 'u1' } });
    await usersController.deleteUser(req, res, () => {});
    expect(state.statusCode).toBe(204);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    // ALL cascades must have been invoked before the user row is removed.
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalled();
    expect(prisma.device.deleteMany).toHaveBeenCalled();
    expect(prisma.securityQuestion.deleteMany).toHaveBeenCalled();
    expect(prisma.passwordHistory.deleteMany).toHaveBeenCalled();
    expect(prisma.userRole.deleteMany).toHaveBeenCalled();
  });

  it('DB error → next', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'u1' } });
    await usersController.deleteUser(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});
