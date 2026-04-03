import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `res_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `res_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

let resourceId: string;
let resourceId2: string;
let hourId: string;
let closureId: string;
let travelTimeId: string;

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
  // Clean up travel times
  if (travelTimeId) {
    await prisma.travelTimeMatrix.deleteMany({ where: { id: travelTimeId } }).catch(() => {});
  }
  // Clean up closures
  if (resourceId) {
    await prisma.resourceClosure.deleteMany({ where: { resourceId } }).catch(() => {});
    await prisma.resourceHour.deleteMany({ where: { resourceId } }).catch(() => {});
  }
  // Clean up resources
  if (resourceId) {
    await prisma.resource.deleteMany({ where: { id: resourceId } }).catch(() => {});
  }
  if (resourceId2) {
    await prisma.resourceClosure.deleteMany({ where: { resourceId: resourceId2 } }).catch(() => {});
    await prisma.resourceHour.deleteMany({ where: { resourceId: resourceId2 } }).catch(() => {});
    await prisma.resource.deleteMany({ where: { id: resourceId2 } }).catch(() => {});
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

describe('POST /resources', () => {
  it('201 — creates resource', async () => {
    const res = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        name: `Test Attraction ${ts}`,
        type: 'attraction',
        city: 'TestCity',
        region: 'TestRegion',
        country: 'TestCountry',
        minDwellMinutes: 30,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe(`Test Attraction ${ts}`);
    expect(res.body.type).toBe('attraction');
    resourceId = res.body.id;
  });
});

describe('GET /resources', () => {
  it('200 — lists resources', async () => {
    const res = await request(app)
      .get('/resources')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /resources/:id', () => {
  it('200 — gets single resource', async () => {
    const res = await request(app)
      .get(`/resources/${resourceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(resourceId);
    expect(res.body.name).toBe(`Test Attraction ${ts}`);
  });
});

describe('PATCH /resources/:id', () => {
  it('200 — updates resource', async () => {
    const res = await request(app)
      .patch(`/resources/${resourceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ city: 'UpdatedCity' });
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('UpdatedCity');
  });
});

describe('POST /resources/:id/hours', () => {
  it('201 — sets business hours', async () => {
    const res = await request(app)
      .post(`/resources/${resourceId}/hours`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.dayOfWeek).toBe(1);
    expect(res.body.openTime).toBe('09:00');
    expect(res.body.closeTime).toBe('17:00');
    hourId = res.body.id;
  });
});

describe('GET /resources/:id/hours', () => {
  it('200 — lists hours', async () => {
    const res = await request(app)
      .get(`/resources/${resourceId}/hours`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /resources/:id/closures', () => {
  it('201 — adds closure', async () => {
    const res = await request(app)
      .post(`/resources/${resourceId}/closures`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ date: '2026-12-25', reason: 'Christmas' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.reason).toBe('Christmas');
    closureId = res.body.id;
  });
});

describe('POST /travel-times', () => {
  it('200 — creates travel time', async () => {
    // Create a second resource for travel time matrix
    const res2 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        name: `Test Attraction 2 ${ts}`,
        type: 'attraction',
        city: 'TestCity2',
        minDwellMinutes: 45,
      });
    resourceId2 = res2.body.id;

    const res = await request(app)
      .post('/travel-times')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        fromResourceId: resourceId,
        toResourceId: resourceId2,
        transportMode: 'walking',
        travelMinutes: 20,
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.travelMinutes).toBe(20);
    travelTimeId = res.body.id;
  });
});

describe('DELETE /resources/:id', () => {
  it('204 — deletes resource', async () => {
    // Delete the second resource (first one may be referenced by travel time)
    // First clean up travel time
    if (travelTimeId) {
      await prisma.travelTimeMatrix.deleteMany({
        where: {
          OR: [
            { fromResourceId: resourceId2 },
            { toResourceId: resourceId2 },
          ],
        },
      });
      travelTimeId = ''; // Already cleaned up
    }

    const res = await request(app)
      .delete(`/resources/${resourceId2}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(204);
    resourceId2 = ''; // Already deleted
  });
});
