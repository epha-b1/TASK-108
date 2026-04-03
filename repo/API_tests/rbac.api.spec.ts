import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `rbac_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `rbac_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;
let roleId: string;
let ppId: string;

beforeAll(async () => {
  await prisma.$connect();

  // Register admin user
  const adminReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [
      { question: 'Q1?', answer: 'a1' },
      { question: 'Q2?', answer: 'a2' },
    ],
  });
  adminUserId = adminReg.body.id;

  // Promote to admin role in DB
  await prisma.user.update({
    where: { id: adminUserId },
    data: { role: 'admin' },
  });

  // Login as admin
  const adminLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  // Register organizer user
  const orgReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...orgCreds,
    securityQuestions: [
      { question: 'Q1?', answer: 'a1' },
      { question: 'Q2?', answer: 'a2' },
    ],
  });
  orgUserId = orgReg.body.id;

  // Login as organizer
  const orgLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgCreds);
  orgToken = orgLogin.body.accessToken;
});

afterAll(async () => {
  // Clean up test data
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: uid } });
    await prisma.device.deleteMany({ where: { userId: uid } });
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } });
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } });
    await prisma.userRole.deleteMany({ where: { userId: uid } });
  }
  if (roleId) {
    await prisma.rolePermissionPoint.deleteMany({ where: { roleId } });
    await prisma.role.deleteMany({ where: { id: roleId } });
  }
  if (ppId) {
    await prisma.permissionPoint.deleteMany({ where: { id: ppId } });
  }
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    await prisma.user.deleteMany({ where: { id: uid } });
  }
  await prisma.$disconnect();
});

describe('POST /roles', () => {
  it('201 — admin creates a role', async () => {
    const res = await request(app)
      .post('/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `testrole_${ts}`, description: 'Test role' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe(`testrole_${ts}`);
    roleId = res.body.id;
  });

  it('403 — organizer cannot create a role', async () => {
    const res = await request(app)
      .post('/roles')
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: 'unauthorized_role', description: 'Should fail' });
    expect(res.status).toBe(403);
  });
});

describe('GET /roles', () => {
  it('200 — lists roles', async () => {
    const res = await request(app)
      .get('/roles')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /permission-points', () => {
  it('201 — admin creates a permission point', async () => {
    const res = await request(app)
      .post('/permission-points')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code: `test:perm_${ts}`, description: 'Test permission' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(`test:perm_${ts}`);
    ppId = res.body.id;
  });

  it('403 — organizer cannot create a permission point', async () => {
    const res = await request(app)
      .post('/permission-points')
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code: 'unauth:perm', description: 'Should fail' });
    expect(res.status).toBe(403);
  });
});

describe('POST /roles/:id/permissions', () => {
  it('200 — assigns permissions to role', async () => {
    const res = await request(app)
      .post(`/roles/${roleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ permissionPointIds: [ppId] });
    expect(res.status).toBe(200);
    expect(res.body.rolePermissionPoints).toBeDefined();
    expect(res.body.rolePermissionPoints.length).toBe(1);
  });
});

describe('POST /users/:id/roles', () => {
  it('200 — assigns role to user', async () => {
    const res = await request(app)
      .post(`/users/${orgUserId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ roleIds: [roleId] });
    expect(res.status).toBe(200);
    expect(res.body.userRoles).toBeDefined();
    expect(res.body.userRoles.length).toBe(1);
  });

  it('403 — organizer cannot assign roles', async () => {
    const res = await request(app)
      .post(`/users/${orgUserId}/roles`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ roleIds: [roleId] });
    expect(res.status).toBe(403);
  });
});

describe('GET /users (admin-only)', () => {
  it('200 — admin can list users', async () => {
    const res = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('403 — organizer cannot list users', async () => {
    const res = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(403);
  });

  it('401 — no token', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /users/:id', () => {
  it('200 — admin can get any user', async () => {
    const res = await request(app)
      .get(`/users/${orgUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(orgCreds.username);
  });

  it('200 — organizer can get a user by ID', async () => {
    const res = await request(app)
      .get(`/users/${orgUserId}`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /menus', () => {
  it('200 — lists menus', async () => {
    const res = await request(app)
      .get('/menus')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /menus', () => {
  it('201 — admin creates a menu with permissions', async () => {
    const res = await request(app)
      .post('/menus')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        name: `testmenu_${ts}`,
        description: 'Test menu',
        permissionPointIds: [ppId],
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`testmenu_${ts}`);
    expect(res.body.menuPermissionPoints.length).toBe(1);

    // Clean up menu
    await prisma.menuPermissionPoint.deleteMany({ where: { menuId: res.body.id } });
    await prisma.menu.delete({ where: { id: res.body.id } });
  });
});
