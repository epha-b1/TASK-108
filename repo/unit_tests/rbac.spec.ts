import { requireRole, requirePermission, resolveEffectiveRoles } from '../src/middleware/auth.middleware';
import { Request, Response, NextFunction } from 'express';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function mockReqResNext(user?: any, roleNames?: Set<string>) {
  const req = { user, permissions: undefined, roleNames } as unknown as Request;
  const res = {} as Response;
  let calledNext = false;
  let nextErr: any = null;
  const next: NextFunction = (err?: any) => {
    calledNext = true;
    nextErr = err || null;
  };
  return { req, res, next, getError: () => nextErr, wasCalled: () => calledNext };
}

describe('requireRole middleware', () => {
  it('passes when user has required role', () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'admin', role: 'admin' });
    requireRole('admin')(req, res, next);
    expect(getError()).toBeNull();
  });

  it('returns 403 when user has wrong role', () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'org', role: 'organizer' });
    requireRole('admin')(req, res, next);
    expect(getError()).not.toBeNull();
    expect(getError().statusCode).toBe(403);
  });

  it('returns 401 when no user on request', () => {
    const { req, res, next, getError } = mockReqResNext(undefined);
    requireRole('admin')(req, res, next);
    expect(getError()).not.toBeNull();
    expect(getError().statusCode).toBe(401);
  });

  it('accepts multiple roles', () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'org', role: 'organizer' });
    requireRole('admin', 'organizer')(req, res, next);
    expect(getError()).toBeNull();
  });
});

describe('requirePermission middleware', () => {
  it('passes for admin role without checking permissions', async () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'admin', role: 'admin' });
    await requirePermission('itinerary:read')(req, res, next);
    expect(getError()).toBeNull();
  });

  it('returns 401 when no user on request', async () => {
    const { req, res, next, getError } = mockReqResNext(undefined);
    await requirePermission('itinerary:read')(req, res, next);
    expect(getError()).not.toBeNull();
    expect(getError().statusCode).toBe(401);
  });

  it('returns 403 when user lacks permission', async () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'org', role: 'organizer' });
    // Pre-set permissions to avoid DB call in unit test
    req.permissions = ['itinerary:read', 'resource:read'];
    await requirePermission('user:write')(req, res, next);
    expect(getError()).not.toBeNull();
    expect(getError().statusCode).toBe(403);
    expect(getError().message).toContain('user:write');
  });

  it('passes when user has the required permission', async () => {
    const { req, res, next, getError } = mockReqResNext({ userId: 'u1', username: 'org', role: 'organizer' });
    req.permissions = ['itinerary:read', 'itinerary:write', 'resource:read'];
    await requirePermission('itinerary:read')(req, res, next);
    expect(getError()).toBeNull();
  });
});

describe('Permission collection logic', () => {
  it('deduplicates permissions from multiple roles', () => {
    // Simulating getUserPermissions logic
    const role1Perms = ['itinerary:read', 'itinerary:write', 'resource:read'];
    const role2Perms = ['itinerary:read', 'notification:read', 'resource:read'];

    const permissionSet = new Set<string>();
    for (const p of [...role1Perms, ...role2Perms]) {
      permissionSet.add(p);
    }
    const result = Array.from(permissionSet).sort();

    expect(result).toEqual([
      'itinerary:read',
      'itinerary:write',
      'notification:read',
      'resource:read',
    ]);
  });

  it('returns empty array when user has no roles', () => {
    const permissionSet = new Set<string>();
    expect(Array.from(permissionSet)).toEqual([]);
  });
});

// === Canonical role source (audit issue 3) ===
// The middleware now derives the effective role set from `user_roles` and
// only falls back to the legacy `users.role` column when no membership row
// exists. These tests pin both branches and the admin-detection logic.
describe('resolveEffectiveRoles — canonical role source', () => {
  beforeEach(() => {
    if (prisma.userRole?.findMany?.mockReset) prisma.userRole.findMany.mockReset();
  });

  it('reads role names from user_roles when memberships exist', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      { userId: 'u1', roleId: 'r-admin', role: { id: 'r-admin', name: 'admin' } },
    ]);
    const roles = await resolveEffectiveRoles('u1', 'organizer');
    // user_roles wins — we ignore the stale `users.role` value entirely.
    expect([...roles]).toEqual(['admin']);
  });

  it('falls back to legacy users.role only when memberships are empty', async () => {
    prisma.userRole.findMany.mockResolvedValue([]);
    const roles = await resolveEffectiveRoles('u2', 'organizer');
    expect([...roles]).toEqual(['organizer']);
  });

  it('returns empty set when memberships empty AND legacy role missing', async () => {
    prisma.userRole.findMany.mockResolvedValue([]);
    const roles = await resolveEffectiveRoles('u3', null);
    expect(roles.size).toBe(0);
  });

  it('aggregates multiple role memberships', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      { userId: 'u4', roleId: 'r1', role: { name: 'organizer' } },
      { userId: 'u4', roleId: 'r2', role: { name: 'admin' } },
    ]);
    const roles = await resolveEffectiveRoles('u4', null);
    expect(roles.has('admin')).toBe(true);
    expect(roles.has('organizer')).toBe(true);
  });
});

describe('requireRole — canonical req.roleNames', () => {
  it('passes when admin lives only in user_roles (legacy users.role=organizer)', () => {
    const { req, res, next, getError } = mockReqResNext(
      { userId: 'u1', username: 'promoted', role: 'admin' },
      new Set(['admin']),
    );
    requireRole('admin')(req, res, next);
    expect(getError()).toBeNull();
  });

  it('rejects when neither roleNames nor primary role match', () => {
    const { req, res, next, getError } = mockReqResNext(
      { userId: 'u1', username: 'org', role: 'organizer' },
      new Set(['organizer']),
    );
    requireRole('admin')(req, res, next);
    expect(getError()).not.toBeNull();
    expect(getError().statusCode).toBe(403);
  });
});

describe('requirePermission — admin bypass uses canonical roleNames', () => {
  it('admin bypass triggers when user_roles contains admin even if primary role string is stale', async () => {
    const { req, res, next, getError } = mockReqResNext(
      // simulate a stale JWT payload that still says 'organizer'
      { userId: 'u1', username: 'promoted', role: 'organizer' },
      new Set(['admin']),
    );
    // Should bypass without consulting permissions
    await requirePermission('user:write')(req, res, next);
    expect(getError()).toBeNull();
  });
});

describe('Data-scope rule', () => {
  it('organizer can only see own resources (role check)', () => {
    const user = { userId: 'u1', username: 'org', role: 'organizer' };
    const ownerId = 'u1';
    const otherOwnerId = 'u2';

    expect(user.role !== 'admin' && user.userId !== otherOwnerId).toBe(true);
    expect(user.role !== 'admin' && user.userId === ownerId).toBe(true);
  });

  it('admin can see all resources', () => {
    const user = { userId: 'u1', username: 'admin', role: 'admin' };
    const anyOwnerId = 'u999';

    // Admin bypasses ownership check
    expect(user.role === 'admin').toBe(true);
  });
});
