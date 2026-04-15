/**
 * Coverage for `src/services/rbac.service.ts`.
 * Each exported function is exercised with a success path AND the
 * documented failure branches (409 conflict, 404 not-found, 400
 * validation error) so the AppError call sites are all hit.
 */

import * as rbac from '../src/services/rbac.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

describe('createRole', () => {
  it('creates when name is unique', async () => {
    prisma.role.findUnique.mockResolvedValue(null);
    prisma.role.create.mockResolvedValue({ id: 'r1', name: 'editor' });
    const r = await rbac.createRole('editor', 'can edit');
    expect(r).toEqual({ id: 'r1', name: 'editor' });
    expect(prisma.role.create).toHaveBeenCalledWith({ data: { name: 'editor', description: 'can edit' } });
  });

  it('409 when role name already exists', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'r0', name: 'editor' });
    await expect(rbac.createRole('editor')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listRoles', () => {
  it('returns roles sorted by name with permission points', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 'r1' }]);
    const out = await rbac.listRoles();
    expect(out).toEqual([{ id: 'r1' }]);
    const call = prisma.role.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ name: 'asc' });
    expect(call.include.rolePermissionPoints).toBeDefined();
  });
});

describe('assignPermissionsToRole', () => {
  it('404 when role is missing', async () => {
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(rbac.assignPermissionsToRole('rX', ['p1'])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when any permission point id is unknown', async () => {
    prisma.role.findUnique.mockResolvedValueOnce({ id: 'rX' });
    prisma.permissionPoint.findMany.mockResolvedValue([{ id: 'p1' }]); // only 1 of 2
    await expect(rbac.assignPermissionsToRole('rX', ['p1', 'p2'])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('replaces existing and returns the hydrated role', async () => {
    prisma.role.findUnique.mockResolvedValueOnce({ id: 'rX' });
    prisma.permissionPoint.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    prisma.rolePermissionPoint.deleteMany.mockResolvedValue({ count: 3 });
    prisma.rolePermissionPoint.createMany.mockResolvedValue({ count: 2 });
    prisma.role.findUnique.mockResolvedValueOnce({ id: 'rX', rolePermissionPoints: [] });
    const out = await rbac.assignPermissionsToRole('rX', ['p1', 'p2']);
    expect(out).toEqual({ id: 'rX', rolePermissionPoints: [] });
    expect(prisma.rolePermissionPoint.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'rX' } });
    expect(prisma.rolePermissionPoint.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: 'rX', permissionPointId: 'p1' },
        { roleId: 'rX', permissionPointId: 'p2' },
      ],
    });
  });
});

describe('createPermissionPoint', () => {
  it('409 when code exists', async () => {
    prisma.permissionPoint.findUnique.mockResolvedValue({ id: 'p0' });
    await expect(rbac.createPermissionPoint('user:read')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates a new permission point', async () => {
    prisma.permissionPoint.findUnique.mockResolvedValue(null);
    prisma.permissionPoint.create.mockResolvedValue({ id: 'p1', code: 'user:read' });
    const p = await rbac.createPermissionPoint('user:read', 'read users');
    expect(p).toEqual({ id: 'p1', code: 'user:read' });
    expect(prisma.permissionPoint.create).toHaveBeenCalledWith({ data: { code: 'user:read', description: 'read users' } });
  });
});

describe('listPermissionPoints', () => {
  it('returns codes sorted ascending', async () => {
    prisma.permissionPoint.findMany.mockResolvedValue([{ code: 'a' }, { code: 'b' }]);
    const out = await rbac.listPermissionPoints();
    expect(out).toHaveLength(2);
    expect(prisma.permissionPoint.findMany).toHaveBeenCalledWith({ orderBy: { code: 'asc' } });
  });
});

describe('createMenu', () => {
  it('409 when name exists', async () => {
    prisma.menu.findUnique.mockResolvedValue({ id: 'm0' });
    await expect(rbac.createMenu('dashboard')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates menu without permission points (undefined branch)', async () => {
    prisma.menu.findUnique.mockResolvedValue(null);
    prisma.menu.create.mockResolvedValue({ id: 'm1' });
    await rbac.createMenu('x');
    const call = prisma.menu.create.mock.calls[0][0];
    expect(call.data.menuPermissionPoints).toBeUndefined();
  });

  it('creates menu with permission points', async () => {
    prisma.menu.findUnique.mockResolvedValue(null);
    prisma.menu.create.mockResolvedValue({ id: 'm1' });
    await rbac.createMenu('x', 'desc', ['p1', 'p2']);
    const call = prisma.menu.create.mock.calls[0][0];
    expect(call.data.menuPermissionPoints).toEqual({ create: [{ permissionPointId: 'p1' }, { permissionPointId: 'p2' }] });
  });
});

describe('listMenus', () => {
  it('sorts by name and hydrates permission points', async () => {
    prisma.menu.findMany.mockResolvedValue([]);
    await rbac.listMenus();
    const call = prisma.menu.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual({ name: 'asc' });
  });
});

describe('assignRolesToUser', () => {
  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(rbac.assignRolesToUser('uX', ['r1'])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when any role id is unknown', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'uX' });
    prisma.role.findMany.mockResolvedValue([{ id: 'r1' }]);
    await expect(rbac.assignRolesToUser('uX', ['r1', 'r2'])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('replaces user_roles and returns hydrated user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'uX' });
    prisma.role.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.userRole.deleteMany.mockResolvedValue({ count: 0 });
    prisma.userRole.createMany.mockResolvedValue({ count: 1 });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'uX', userRoles: [] });
    const out = await rbac.assignRolesToUser('uX', ['r1']);
    expect(out).toEqual({ id: 'uX', userRoles: [] });
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'uX' } });
    expect(prisma.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'uX', roleId: 'r1' }],
    });
  });
});

describe('getUserPermissions', () => {
  it('deduplicates and sorts permission point codes', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      {
        role: {
          rolePermissionPoints: [
            { permissionPoint: { code: 'z' } },
            { permissionPoint: { code: 'a' } },
          ],
        },
      },
      {
        role: {
          rolePermissionPoints: [
            { permissionPoint: { code: 'a' } },
            { permissionPoint: { code: 'm' } },
          ],
        },
      },
    ]);
    const out = await rbac.getUserPermissions('u1');
    expect(out).toEqual(['a', 'm', 'z']);
  });

  it('returns [] when the user has no memberships', async () => {
    prisma.userRole.findMany.mockResolvedValue([]);
    const out = await rbac.getUserPermissions('u1');
    expect(out).toEqual([]);
  });
});
