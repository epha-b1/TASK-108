import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `mdl_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `mdl_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

let modelId: string;

beforeAll(async () => {
  await prisma.$connect();

  // Register admin
  const adminReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [
      { question: 'Q1?', answer: 'a1' },
      { question: 'Q2?', answer: 'a2' },
    ],
  });
  adminUserId = adminReg.body.id;

  // Promote to admin
  await prisma.user.update({
    where: { id: adminUserId },
    data: { role: 'admin' },
  });

  // Login as admin
  const adminLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  // Register organizer
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
}, 15000);

afterAll(async () => {
  // Clean up model and allocations
  if (modelId) {
    await prisma.abAllocation.deleteMany({ where: { modelId } }).catch(() => {});
    await prisma.mlModel.deleteMany({ where: { id: modelId } }).catch(() => {});
  }
  // Clean up users
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('POST /models', () => {
  it('201 — registers model', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        name: `test-model-${ts}`,
        version: '1.0.0',
        type: 'custom',
        config: {
          features: ['budget', 'distance', 'rating'],
          rules: [
            {
              name: 'low_budget',
              condition: 'input.budget < 100',
              output: { prediction: 'budget', confidence: 0.95 },
            },
          ],
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe(`test-model-${ts}`);
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.status).toBe('inactive');
    modelId = res.body.id;
  });
});

describe('GET /models', () => {
  it('200 — lists models', async () => {
    const res = await request(app)
      .get('/models')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /models/:id', () => {
  it('200 — activates model', async () => {
    const res = await request(app)
      .patch(`/models/${modelId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });
});

describe('POST /models/:id/ab-allocations', () => {
  it('200 — sets allocation (admin only)', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/ab-allocations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ groupName: 'test-group', percentage: 50 });
    expect(res.status).toBe(200);
    expect(res.body.groupName).toBe('test-group');
  });

  it('403 — organizer cannot set allocation', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/ab-allocations`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ groupName: 'other-group', percentage: 25 });
    expect(res.status).toBe(403);
  });
});

describe('POST /models/:id/infer', () => {
  it('200 — returns prediction with explainability', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        input: { budget: 150, distance: 5, rating: 4.5 },
        context: { userId: adminUserId },
      });
    expect(res.status).toBe(200);
    expect(res.body.prediction).toBeDefined();
    expect(res.body.confidence).toBeDefined();
    expect(typeof res.body.confidence).toBe('number');
    expect(res.body.confidenceBand).toBeDefined();
    expect(Array.isArray(res.body.confidenceBand)).toBe(true);
    expect(res.body.confidenceBand.length).toBe(2);
    expect(res.body.topFeatures).toBeDefined();
    expect(Array.isArray(res.body.topFeatures)).toBe(true);
    expect(res.body.appliedRules).toBeDefined();
    expect(Array.isArray(res.body.appliedRules)).toBe(true);
  });
});
