/**
 * Decisioning (`/models/*`) + payload-quality assertions and the RBAC
 * boundary matrix for the model registry.
 *
 * These tests go beyond "did we get 2xx" and assert the shape and
 * invariants of every inference response (confidence band width,
 * topFeatures monotonicity, applied-rule override wiring, deterministic
 * mock output stability) plus every negative-access permutation.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `mdl2_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `mdl2_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;
let modelId: string;

beforeAll(async () => {
  await prisma.$connect();

  const adminReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  adminUserId = adminReg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const adminLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  const orgReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...orgCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  orgUserId = orgReg.body.id;
  const orgLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgCreds);
  orgToken = orgLogin.body.accessToken;

  const register = await request(app)
    .post('/models')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({
      name: `quality-model-${ts}`,
      version: '1.2.3',
      type: 'custom',
      config: {
        features: ['budget', 'distance', 'rating', 'reviews'],
        rules: [
          {
            name: 'budget_gate',
            condition: 'input.budget < 100',
            output: { prediction: 'budget_plan', confidence: 0.95 },
          },
        ],
      },
    });
  expect(register.status).toBe(201);
  modelId = register.body.id;

  await request(app)
    .patch(`/models/${modelId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ status: 'active' });
}, 20000);

afterAll(async () => {
  if (modelId) {
    await prisma.abAllocation.deleteMany({ where: { modelId } }).catch(() => {});
    await prisma.mlModel.deleteMany({ where: { id: modelId } }).catch(() => {});
  }
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

describe('POST /models — validation and registry invariants', () => {
  it('400 — non-semver version is rejected', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `bad-semver-${ts}`, version: 'v1', type: 'custom' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // The top-level message is the generic envelope string; the per-field
    // hint ("Must be semantic version …") lives in details[].message.
    const versionErr = (res.body.details ?? []).find(
      (d: { field: string; message: string }) => d.field === 'version',
    );
    expect(versionErr).toBeDefined();
    expect(versionErr.message).toMatch(/semver|semantic version/i);
  });

  it('400 — unknown type is rejected', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `bad-type-${ts}`, version: '1.0.0', type: 'random-forest' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('409 — re-registering same (name, version) conflicts', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `quality-model-${ts}`, version: '1.2.3', type: 'custom' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});

describe('POST /models/:id/infer — explainability payload contract', () => {
  it('returns structurally complete inference with bounded confidence band', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        input: { budget: 500, distance: 5, rating: 4.5, reviews: 120 },
        context: { userId: adminUserId },
      });
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.prediction).toBeDefined();
    expect(typeof body.confidence).toBe('number');
    expect(body.confidence).toBeGreaterThanOrEqual(0);
    expect(body.confidence).toBeLessThanOrEqual(1);

    // Confidence band: 2 numbers, sorted ascending, bracketing the confidence,
    // and fully inside [0, 1].
    expect(Array.isArray(body.confidenceBand)).toBe(true);
    expect(body.confidenceBand).toHaveLength(2);
    const [lo, hi] = body.confidenceBand;
    expect(typeof lo).toBe('number');
    expect(typeof hi).toBe('number');
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThanOrEqual(body.confidence);
    expect(hi).toBeGreaterThanOrEqual(body.confidence);

    // topFeatures: array of { feature: string, contribution: number },
    // monotonically non-increasing by contribution, all features from config.
    expect(Array.isArray(body.topFeatures)).toBe(true);
    expect(body.topFeatures.length).toBeGreaterThan(0);
    for (let i = 1; i < body.topFeatures.length; i++) {
      expect(body.topFeatures[i - 1].contribution).toBeGreaterThanOrEqual(
        body.topFeatures[i].contribution,
      );
    }
    const configFeatures = new Set(['budget', 'distance', 'rating', 'reviews']);
    for (const f of body.topFeatures) {
      expect(configFeatures.has(f.feature)).toBe(true);
    }

    // appliedRules: array of { rule, triggered } — MUST include the configured rule.
    expect(Array.isArray(body.appliedRules)).toBe(true);
    const ruleNames = body.appliedRules.map((r: { rule: string }) => r.rule);
    expect(ruleNames).toContain('budget_gate');
  });

  it('mock adapter is DETERMINISTIC for identical inputs (same prediction + features)', async () => {
    const req1 = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 777, distance: 12, rating: 3.1, reviews: 40 }, context: {} });
    const req2 = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 777, distance: 12, rating: 3.1, reviews: 40 }, context: {} });
    expect(req1.status).toBe(200);
    expect(req2.status).toBe(200);
    expect(req1.body.prediction).toEqual(req2.body.prediction);
    expect(req1.body.topFeatures).toEqual(req2.body.topFeatures);
  });

  it('rule override fires when condition matches: prediction + confidence come from the rule', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 50, distance: 5, rating: 4.5, reviews: 10 }, context: {} });
    expect(res.status).toBe(200);
    expect(res.body.prediction).toBe('budget_plan');
    expect(res.body.confidence).toBe(0.95);
    const fired = res.body.appliedRules.find(
      (r: { rule: string; triggered: boolean }) => r.rule === 'budget_gate',
    );
    expect(fired?.triggered).toBe(true);
  });

  it('rule NOT triggered when budget above threshold — mock adapter result is preserved', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { budget: 250, distance: 5, rating: 4.5, reviews: 10 }, context: {} });
    expect(res.status).toBe(200);
    const fired = res.body.appliedRules.find(
      (r: { rule: string; triggered: boolean }) => r.rule === 'budget_gate',
    );
    expect(fired?.triggered).toBe(false);
    // Prediction is whatever the mock adapter returned — MUST NOT be the rule output.
    expect(res.body.prediction).not.toBe('budget_plan');
  });

  it('400 — inference on inactive model is rejected with canonical envelope', async () => {
    const inactiveReg = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `inactive-${ts}`, version: '0.1.0', type: 'custom' });
    expect(inactiveReg.status).toBe(201);
    const inactiveId = inactiveReg.body.id;

    const res = await request(app)
      .post(`/models/${inactiveId}/infer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: { x: 1 }, context: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/not active|inactive/i);

    await prisma.abAllocation.deleteMany({ where: { modelId: inactiveId } }).catch(() => {});
    await prisma.mlModel.delete({ where: { id: inactiveId } });
  });

  it('404 — inference on unknown model id is canonical NOT_FOUND', async () => {
    const res = await request(app)
      .post('/models/00000000-0000-0000-0000-000000000000/infer')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ input: {}, context: {} });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('Model registry RBAC matrix — admin/organizer/unauthenticated', () => {
  it('401 — no bearer token returns UNAUTHORIZED (not 404 or 403)', async () => {
    const res = await request(app).get('/models');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('401 — forged Bearer token is rejected (signature check runs)', async () => {
    const res = await request(app)
      .get('/models')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('403 — organizer without permission cannot register a model', async () => {
    const res = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `org-attempt-${ts}`, version: '0.1.0', type: 'custom' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — organizer cannot set A/B allocations (admin-only)', async () => {
    const res = await request(app)
      .post(`/models/${modelId}/ab-allocations`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ groupName: 'x', percentage: 10 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('403 — organizer cannot change a model status', async () => {
    const res = await request(app)
      .patch(`/models/${modelId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ status: 'inactive' });
    expect(res.status).toBe(403);
  });

  it('404 — GET on unknown model id is canonical NOT_FOUND (no leakage)', async () => {
    const res = await request(app)
      .get('/models/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('POST /models/:id/ab-allocations — validation', () => {
  it('400 — percentage outside 0..100 is rejected', async () => {
    for (const pct of [-10, 150]) {
      const res = await request(app)
        .post(`/models/${modelId}/ab-allocations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', uuid())
        .send({ groupName: 'bad', percentage: pct });
      expect([400]).toContain(res.status);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('404 — allocation on unknown model id is canonical NOT_FOUND', async () => {
    const res = await request(app)
      .post('/models/00000000-0000-0000-0000-000000000000/ab-allocations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ groupName: 'x', percentage: 50 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
