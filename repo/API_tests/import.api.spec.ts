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
  it('200 — downloads resources XLSX template (default)', async () => {
    const res = await request(app)
      .get('/import/templates/resources');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/resources-template\.xlsx/);
  });

  it('200 — downloads resources CSV template via ?format=csv', async () => {
    const res = await request(app)
      .get('/import/templates/resources?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/resources-template\.csv/);
    // CSV body should contain the column headers
    const body = res.text ?? res.body.toString();
    expect(body).toMatch(/name/);
    expect(body).toMatch(/type/);
    expect(body).toMatch(/city/);
  });

  it('200 — CSV via Accept: text/csv header', async () => {
    const res = await request(app)
      .get('/import/templates/resources')
      .set('Accept', 'text/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('200 — downloads itineraries CSV template', async () => {
    const res = await request(app)
      .get('/import/templates/itineraries?format=csv');
    expect(res.status).toBe(200);
    const body = res.text ?? res.body.toString();
    expect(body).toMatch(/title/);
    expect(body).toMatch(/destination/);
  });

  it('400 — rejects invalid format query param', async () => {
    const res = await request(app)
      .get('/import/templates/resources?format=pdf');
    expect(res.status).toBe(400);
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

// === Canonical resource type enum enforcement ===
// Before the unification, import.service accepted attraction|restaurant|hotel|
// transport|activity, while resource.service / schemas only accepted
// attraction|lodging|meal|meeting. Now both share src/schemas/resource.schemas
// RESOURCE_TYPES, and any non-canonical row must surface as a row-level
// VALIDATION_ERROR rather than committing dirty data.
describe('Canonical resource type enforcement', () => {
  it('200 — accepts canonical types (attraction, lodging, meal, meeting)', async () => {
    const csv = [
      'name,type,city',
      `Canon A ${ts},attraction,TestCity`,
      `Canon L ${ts},lodging,TestCity`,
      `Canon M ${ts},meal,TestCity`,
      `Canon T ${ts},meeting,TestCity`,
    ].join('\n') + '\n';

    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `canon_ok_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');

    expect(res.status).toBe(200);
    expect(res.body.errorRows).toBe(0);
    expect(res.body.successRows).toBe(4);
    expect((res.body.errors ?? []).length).toBe(0);

    // Cleanup the rows that the dedup test or commit test might leave behind
    await prisma.resource.deleteMany({ where: { name: { startsWith: `Canon ` } } }).catch(() => {});
  });

  it('200 with row errors — rejects legacy non-canonical types', async () => {
    const csv = [
      'name,type,city',
      `Bad Restaurant ${ts},restaurant,TestCity`,
      `Bad Hotel ${ts},hotel,TestCity`,
      `Bad Transport ${ts},transport,TestCity`,
      `Bad Activity ${ts},activity,TestCity`,
    ].join('\n') + '\n';

    const res = await request(app)
      .post('/import/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .field('entityType', 'resources')
      .field('idempotencyKey', `canon_bad_${ts}`)
      .attach('file', Buffer.from(csv), 'resources.csv');

    expect(res.status).toBe(200);
    expect(res.body.errorRows).toBe(4);
    expect(res.body.successRows).toBe(0);
    const errs = res.body.errors ?? [];
    expect(errs.length).toBeGreaterThanOrEqual(4);
    for (const e of errs) {
      expect(e.field).toBe('type');
      expect(String(e.message)).toMatch(/type must be one of/);
      expect(String(e.message)).toMatch(/attraction.*lodging.*meal.*meeting/);
    }
  });

  it('400 — POST /resources rejects non-canonical type with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `Bad Type ${ts}`, type: 'restaurant', city: 'TestCity' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
