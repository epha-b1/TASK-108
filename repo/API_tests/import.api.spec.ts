import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `imp_admin_${ts}`, password: 'AdminPass123!x' };

let adminToken: string;
let adminUserId: string;
let batchId: string;

beforeAll(async () => {
  await prisma.$connect();

  const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  adminUserId = reg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const login = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = login.body.accessToken;
}, 15000);

afterAll(async () => {
  // Clean up import batches
  await prisma.importError.deleteMany({ where: { batch: { userId: adminUserId } } }).catch(() => {});
  await prisma.importBatch.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
  // Clean up imported resources
  await prisma.resource.deleteMany({ where: { name: { startsWith: 'Test Place' } } }).catch(() => {});
  await prisma.resource.deleteMany({ where: { name: { startsWith: 'Rollback Place' } } }).catch(() => {});
  await prisma.resource.deleteMany({ where: { name: { startsWith: 'Expired Place' } } }).catch(() => {});
  // Clean up user
  if (adminUserId) {
    await prisma.refreshToken.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('GET /import/templates/:entityType', () => {
  it('200 — downloads resources template', async () => {
    const res = await request(app)
      .get('/import/templates/resources')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /import/upload', () => {
  it('200 — uploads CSV and gets validation report', async () => {
    const csv = 'name,type,streetLine,city\nTest Place,attraction,123 Main St,TestCity\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `key_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    batchId = res.body.id;
  });

  it('200 — duplicate idempotency key returns same batch (idempotent)', async () => {
    const csv = 'name,type,streetLine,city\nAnother Place,attraction,456 Oak,TestCity\n';
    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `key_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(batchId);
  });
});

describe('POST /import/:batchId/commit', () => {
  it('200 — commits validated batch', async () => {
    const res = await request(app)
      .post(`/import/${batchId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });
});

describe('POST /import/:batchId/rollback', () => {
  it('200 — rollback within window', async () => {
    const csv = 'name,type,streetLine,city\nRollback Place,attraction,789 Elm,TestCity\n';
    const uploadRes = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `rollback_key_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');
    const rollbackBatchId = uploadRes.body.id;

    await request(app)
      .post(`/import/${rollbackBatchId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());

    const res = await request(app)
      .post(`/import/${rollbackBatchId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rolled_back');
  });

  it('409 — rollback after window expired', async () => {
    const csv = 'name,type,streetLine,city\nExpired Place,attraction,000 Pine,TestCity\n';
    const uploadRes = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `expired_key_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');
    const expiredBatchId = uploadRes.body.id;

    await request(app)
      .post(`/import/${expiredBatchId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());

    // Expire the rollback window
    await prisma.importBatch.update({
      where: { id: expiredBatchId },
      data: { rollbackUntil: new Date(Date.now() - 60000) },
    });

    const res = await request(app)
      .post(`/import/${expiredBatchId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(409);
  });
});

describe('GET /import/:batchId', () => {
  it('200 — returns batch status', async () => {
    const res = await request(app)
      .get(`/import/${batchId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(batchId);
  });
});
