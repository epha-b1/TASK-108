import request from 'supertest';
import { v4 as uuid } from 'uuid';
import { sign as jwtSign } from 'jsonwebtoken';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

// Shared test users
const adminCreds = { username: `acc_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `acc_org_${ts}`, password: 'OrgPass12345!x' };
const orgBCreds = { username: `acc_orgB_${ts}`, password: 'OrgPass12345!y' };

let adminToken: string;
let orgToken: string;
let orgBToken: string;
let adminUserId: string;
let orgUserId: string;
let orgBUserId: string;

beforeAll(async () => {
  await prisma.$connect();

  // Register and setup admin
  const adminReg = await request(app).post('/auth/register')
    .set('Idempotency-Key', uuid())
    .send({ ...adminCreds, securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }] });
  adminUserId = adminReg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const adminLogin = await request(app).post('/auth/login')
    .set('Idempotency-Key', uuid())
    .send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  // Register org user
  const orgReg = await request(app).post('/auth/register')
    .set('Idempotency-Key', uuid())
    .send({ ...orgCreds, securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }] });
  orgUserId = orgReg.body.id;

  // Setup RBAC for org user. The permission set was widened to mirror the
  // shipped organizer baseline (now includes import:read so the cross-user
  // isolation test below actually exercises *object*-level enforcement, not
  // a route-level permission gate).
  const orgPerms = [
    'itinerary:read', 'itinerary:write',
    'resource:read',
    'import:read', 'import:write',
    'model:read',
    'notification:read',
  ];
  const ppIds: string[] = [];
  for (const code of orgPerms) {
    const pp = await prisma.permissionPoint.upsert({ where: { code }, update: {}, create: { code } });
    ppIds.push(pp.id);
  }
  const orgRole = await prisma.role.upsert({ where: { name: 'organizer' }, update: {}, create: { name: 'organizer' } });
  await prisma.rolePermissionPoint.deleteMany({ where: { roleId: orgRole.id } });
  await prisma.rolePermissionPoint.createMany({ data: ppIds.map(id => ({ roleId: orgRole.id, permissionPointId: id })) });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: orgUserId, roleId: orgRole.id } }, update: {}, create: { userId: orgUserId, roleId: orgRole.id } });

  const orgLogin = await request(app).post('/auth/login')
    .set('Idempotency-Key', uuid())
    .send(orgCreds);
  orgToken = orgLogin.body.accessToken;

  // Register orgB
  const orgBReg = await request(app).post('/auth/register')
    .set('Idempotency-Key', uuid())
    .send({ ...orgBCreds, securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }] });
  orgBUserId = orgBReg.body.id;
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: orgBUserId, roleId: orgRole.id } }, update: {}, create: { userId: orgBUserId, roleId: orgRole.id } });
  const orgBLogin = await request(app).post('/auth/login')
    .set('Idempotency-Key', uuid())
    .send(orgBCreds);
  orgBToken = orgBLogin.body.accessToken;
}, 30000);

afterAll(async () => {
  for (const uid of [adminUserId, orgUserId, orgBUserId]) {
    if (!uid) continue;
    const itins = await prisma.itinerary.findMany({ where: { ownerId: uid } }).catch(() => []);
    for (const it of itins) {
      await prisma.itineraryItem.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
      await prisma.itineraryVersion.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
    }
    await prisma.itinerary.deleteMany({ where: { ownerId: uid } }).catch(() => {});
    await prisma.importError.deleteMany({ where: { batch: { userId: uid } } }).catch(() => {});
    await prisma.importBatch.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  }
  await prisma.idempotencyKey.deleteMany({ where: { key: { startsWith: 'challenge:' } } }).catch(() => {});
  await prisma.$disconnect();
});

// === C) Global Idempotency ===
describe('Idempotency enforcement', () => {
  it('400 — missing Idempotency-Key on POST', async () => {
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TestR', type: 'attraction' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('400 — missing Idempotency-Key on PATCH', async () => {
    const res = await request(app)
      .patch('/auth/change-password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ currentPassword: adminCreds.password, newPassword: 'NewAdmin123!xx' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('replay — same key + same payload returns cached response', async () => {
    const key = uuid();
    const body = { name: `Idem Res ${ts}`, type: 'attraction', city: 'IdempotencyCity' };

    const res1 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send(body);
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send(body);
    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(res1.body.id);

    // cleanup
    if (res1.body.id) await prisma.resource.deleteMany({ where: { id: res1.body.id } }).catch(() => {});
  });

  it('409 — same key + different payload', async () => {
    const key = uuid();

    await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({ name: `IdemA ${ts}`, type: 'attraction' });

    const res2 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send({ name: `IdemB ${ts}`, type: 'lodging' });
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe('IDEMPOTENCY_CONFLICT');

    // cleanup
    await prisma.resource.deleteMany({ where: { name: { startsWith: `IdemA ${ts}` } } }).catch(() => {});
  });

  // === Auth-boundary replay regression ===
  // A reused idempotency key MUST NOT allow an unauthenticated/forged caller
  // to observe the cached success response of a real authenticated request
  // on a protected mutating route. The middleware must reject with an auth
  // failure (401/403) and the cached body must NOT be returned.
  describe('Auth-boundary replay regression', () => {
    let key: string;
    let originalResourceId: string;
    const originalBody = {
      name: `IdemAuthBoundary_${ts}_${uuid()}`,
      type: 'attraction',
      city: 'BoundaryCity',
    };

    beforeAll(async () => {
      key = uuid();
      // Seed: legitimate admin POST that gets cached.
      const res = await request(app)
        .post('/resources')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key)
        .send(originalBody);
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      originalResourceId = res.body.id;
    });

    afterAll(async () => {
      if (originalResourceId) {
        await prisma.resource.deleteMany({ where: { id: originalResourceId } }).catch(() => {});
      }
      await prisma.resource.deleteMany({ where: { name: { startsWith: `IdemAuthBoundary_${ts}` } } }).catch(() => {});
      await prisma.idempotencyKey.deleteMany({ where: { key } }).catch(() => {});
    });

    it('401 — replay with NO bearer token returns auth failure, not cached body', async () => {
      const res = await request(app)
        .post('/resources')
        .set('Idempotency-Key', key)
        .send(originalBody);
      expect([401, 403]).toContain(res.status);
      // Critical: must NOT leak the cached resource id from the original
      // authenticated call.
      expect(res.body.id).toBeUndefined();
      expect(res.body.id).not.toBe(originalResourceId);
    });

    it('401 — replay with malformed bearer returns auth failure, not cached body', async () => {
      const res = await request(app)
        .post('/resources')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .set('Idempotency-Key', key)
        .send(originalBody);
      expect([401, 403]).toContain(res.status);
      expect(res.body.id).toBeUndefined();
      expect(res.body.id).not.toBe(originalResourceId);
    });

    it('401 — replay with forged bearer (wrong secret) returns auth failure, not cached body', async () => {
      // Sign a token with the WRONG secret but a payload claiming to be admin.
      // The previous (vulnerable) middleware fingerprinted using the unverified
      // payload, so a forged token with the right userId would have hit the
      // cache. Verifying the signature inside the middleware closes that gap.
      const forged = jwtSign(
        { userId: adminUserId, username: adminCreds.username, role: 'admin' },
        'completely-wrong-secret-not-the-real-one',
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      const res = await request(app)
        .post('/resources')
        .set('Authorization', `Bearer ${forged}`)
        .set('Idempotency-Key', key)
        .send(originalBody);
      expect([401, 403]).toContain(res.status);
      expect(res.body.id).toBeUndefined();
      expect(res.body.id).not.toBe(originalResourceId);
    });

    it('201 — legitimate admin replay still works (positive control)', async () => {
      // Confirms the security fix did not break the existing same-actor
      // same-payload replay semantics.
      const res = await request(app)
        .post('/resources')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', key)
        .send(originalBody);
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(originalResourceId);
    });
  });
});

// === D) Model infer authorization ===
describe('Model infer authorization', () => {
  let modelId: string;
  let noPermToken: string;
  let noPermUserId: string;

  beforeAll(async () => {
    // Create model
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `acc_model_${ts}`, version: '1.0.0', type: 'custom' });
    modelId = res.body.id;

    await request(app)
      .patch(`/models/${modelId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ status: 'active' });

    // Create a user with NO model:read permission
    const noPermCreds = { username: `acc_noperm_${ts}`, password: 'NoPermPass123!x' };
    const reg = await request(app).post('/auth/register')
      .set('Idempotency-Key', uuid())
      .send({ ...noPermCreds, securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }] });
    noPermUserId = reg.body.id;

    // Create a role with NO model permissions and assign it
    const bareRole = await prisma.role.upsert({
      where: { name: 'bare_role' },
      update: {},
      create: { name: 'bare_role', description: 'No model permissions' },
    });
    // Only give itinerary:read — explicitly no model:read
    const itinPP = await prisma.permissionPoint.upsert({
      where: { code: 'itinerary:read' },
      update: {},
      create: { code: 'itinerary:read' },
    });
    await prisma.rolePermissionPoint.deleteMany({ where: { roleId: bareRole.id } });
    await prisma.rolePermissionPoint.create({
      data: { roleId: bareRole.id, permissionPointId: itinPP.id },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: noPermUserId, roleId: bareRole.id } },
      update: {},
      create: { userId: noPermUserId, roleId: bareRole.id },
    });

    const login = await request(app).post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send(noPermCreds);
    noPermToken = login.body.accessToken;
  }, 15000);

  afterAll(async () => {
    if (modelId) {
      await prisma.abAllocation.deleteMany({ where: { modelId } }).catch(() => {});
      await prisma.mlModel.deleteMany({ where: { id: modelId } }).catch(() => {});
    }
    if (noPermUserId) {
      await prisma.refreshToken.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.device.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.securityQuestion.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.passwordHistory.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.loginAttempt.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { userId: noPermUserId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: noPermUserId } }).catch(() => {});
    }
  });

  it('200 — authorized user (with model:read) can infer', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 100 } });
    expect(res.status).toBe(200);
    expect(res.body.prediction).toBeDefined();
    expect(res.body.confidence).toBeDefined();
  });

  it('403 — authenticated user WITHOUT model:read cannot infer', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${noPermToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 100 } });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  it('401 — unauthenticated request rejected', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 100 } });
    expect(res.status).toBe(401);
  });
});

// === Validation 400 tests ===
describe('Zod validation on mutating routes', () => {
  it('400 — itinerary create missing title', async () => {
    const res = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ destination: 'Nowhere' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toBeDefined();
  });

  it('400 — itinerary add item invalid resourceId', async () => {
    const res = await request(app)
      .post('/itineraries/00000000-0000-0000-0000-000000000000/items')
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: 'not-a-uuid', dayNumber: 1, startTime: '09:00', endTime: '10:00' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — notification send missing type', async () => {
    const res = await request(app)
      .post('/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ userId: adminUserId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — notification template create missing body', async () => {
    const res = await request(app)
      .post('/notification-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code: 'test_code' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — model register invalid version', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: 'test', version: 'not-semver', type: 'custom' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// === Import validation 400 tests ===
describe('Import route validation', () => {
  it('400 — upload missing entityType', async () => {
    const csv = 'name,type\nX,attraction\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('idempotencyKey', `val_${ts}`)
      .attach('file', Buffer.from(csv), 'r.csv');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.some((d: any) => d.field === 'entityType')).toBe(true);
  });

  it('400 — upload missing idempotencyKey', async () => {
    const csv = 'name,type\nX,attraction\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .attach('file', Buffer.from(csv), 'r.csv');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.some((d: any) => d.field === 'idempotencyKey')).toBe(true);
  });

  it('400 — upload invalid entityType', async () => {
    const csv = 'name,type\nX,attraction\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'invalid_type')
      .field('idempotencyKey', `val2_${ts}`)
      .attach('file', Buffer.from(csv), 'r.csv');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 — commit with non-UUID batchId', async () => {
    const res = await request(app)
      .post('/import/not-a-uuid/commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.some((d: any) => d.field === 'batchId')).toBe(true);
  });

  it('400 — rollback with non-UUID batchId', async () => {
    const res = await request(app)
      .post('/import/not-a-uuid/rollback')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// === G) Import ownership ===
describe('Import ownership/security', () => {
  let batchId: string;

  it('upload returns batch with row data', async () => {
    const csv = 'name,type,streetLine,city\nAcc Test Place,attraction,123 Main St,TestCity\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `acc_key_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');
    expect(res.status).toBe(200);
    batchId = res.body.id;
  });

  it('non-owner cannot view batch', async () => {
    if (!batchId) return;
    const res = await request(app)
      .get(`/import/${batchId}`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    if (batchId) {
      await prisma.importError.deleteMany({ where: { batchId } }).catch(() => {});
      await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch(() => {});
    }
  });
});
