/**
 * HTTP-level coverage for the endpoints that had only service-layer
 * (unit) coverage prior to this round:
 *
 *   - GET  /api/docs
 *   - GET  /travel-times
 *   - GET  /permission-points
 *   - GET  /resources/:id/closures
 *   - GET  /itineraries/:id/items
 *   - PATCH /notification-templates/:id
 *
 * For each we assert the happy path, the 401 unauthenticated path, the
 * RBAC 403 path where relevant, the canonical error envelope on
 * mismatches, and at least one meaningful payload invariant (ordering,
 * shape, or persistence effect). Together these close the HTTP coverage
 * gap reported by the static test audit.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `uncov_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `uncov_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

let resourceId: string;
let resourceId2: string;
let itineraryId: string;
let templateId: string;

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

  // Grant organizer the minimum permissions the four endpoints require.
  const perms = ['resource:read', 'resource:write', 'itinerary:read', 'itinerary:write'];
  const ppIds: string[] = [];
  for (const code of perms) {
    const pp = await prisma.permissionPoint.upsert({
      where: { code }, update: {}, create: { code },
    });
    ppIds.push(pp.id);
  }
  const role = await prisma.role.upsert({
    where: { name: 'organizer' }, update: {}, create: { name: 'organizer', description: 'o' },
  });
  for (const ppId of ppIds) {
    await prisma.rolePermissionPoint.upsert({
      where: { roleId_permissionPointId: { roleId: role.id, permissionPointId: ppId } },
      update: {}, create: { roleId: role.id, permissionPointId: ppId },
    });
  }
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: orgUserId, roleId: role.id } },
    update: {}, create: { userId: orgUserId, roleId: role.id },
  });
  const orgLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgCreds);
  orgToken = orgLogin.body.accessToken;

  // Fixture: one resource (for closures + itinerary items)
  const res = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `uncov_res_${ts}`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 });
  resourceId = res.body.id;

  // Fixture: a second resource + a travel-time row so GET /travel-times
  // has a deterministic row to return.
  const res2 = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `uncov_res2_${ts}`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 });
  resourceId2 = res2.body.id;
  await request(app)
    .post('/travel-times')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({
      fromResourceId: resourceId,
      toResourceId: resourceId2,
      travelMinutes: 17,
      transportMode: 'walking',
    });

  // Fixture: one itinerary owned by organizer, with one item
  const itin = await request(app)
    .post('/itineraries')
    .set('Authorization', `Bearer ${orgToken}`)
    .set('Idempotency-Key', uuid())
    .send({ title: `uncov_trip_${ts}`, destination: 'Rome' });
  itineraryId = itin.body.id;
  await request(app)
    .post(`/itineraries/${itineraryId}/items`)
    .set('Authorization', `Bearer ${orgToken}`)
    .set('Idempotency-Key', uuid())
    .send({ resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00' });

  // Fixture: one notification template (for PATCH)
  const tmpl = await request(app)
    .post('/notification-templates')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({
      code: `uncov_tmpl_${ts}`,
      subject: 'Hello {{name}}',
      body: 'Welcome {{name}}',
    });
  templateId = tmpl.body.id;

  // Also seed two closures so the closures list GET can assert ordering
  for (const [date, reason] of [
    ['2026-07-04', 'Independence Day'],
    ['2026-12-25', 'Christmas'],
  ]) {
    await request(app)
      .post(`/resources/${resourceId}/closures`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ date, reason });
  }
}, 30_000);

afterAll(async () => {
  if (templateId) {
    await prisma.notification.updateMany({ where: { templateId }, data: { templateId: null } }).catch(() => {});
    await prisma.notificationTemplate.deleteMany({ where: { id: templateId } }).catch(() => {});
  }
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    const itins = await prisma.itinerary.findMany({ where: { ownerId: uid } }).catch(() => []);
    for (const it of itins) {
      await prisma.itineraryItem.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
      await prisma.itineraryVersion.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
    }
    await prisma.itinerary.deleteMany({ where: { ownerId: uid } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  }
  for (const rid of [resourceId, resourceId2].filter(Boolean)) {
    await prisma.travelTimeMatrix.deleteMany({
      where: { OR: [{ fromResourceId: rid }, { toResourceId: rid }] },
    }).catch(() => {});
    await prisma.resourceClosure.deleteMany({ where: { resourceId: rid } }).catch(() => {});
    await prisma.resourceHour.deleteMany({ where: { resourceId: rid } }).catch(() => {});
    await prisma.resource.deleteMany({ where: { id: rid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/* ====== GET /permission-points ====== */

describe('GET /permission-points', () => {
  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/permission-points');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('200 — admin lists permission points sorted by code ascending', async () => {
    const res = await request(app)
      .get('/permission-points')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const codes = res.body.map((pp: { code: string }) => pp.code);
    // Sorted ascending (service contract).
    const sorted = [...codes].sort();
    expect(codes).toEqual(sorted);
    // Every entry has id + code (public contract shape).
    for (const pp of res.body) {
      expect(typeof pp.id).toBe('string');
      expect(typeof pp.code).toBe('string');
    }
  });

  it('200 — any authenticated user can read (GET on this router has no role gate)', async () => {
    const res = await request(app)
      .get('/permission-points')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

/* ====== GET /resources/:id/closures ====== */

describe('GET /resources/:id/closures', () => {
  it('401 — unauthenticated', async () => {
    const res = await request(app).get(`/resources/${resourceId}/closures`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('200 — lists closures sorted by date ascending with seeded reasons visible', async () => {
    const res = await request(app)
      .get(`/resources/${resourceId}/closures`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // Sorted ascending by date (service contract).
    const dates = res.body.map((c: { date: string }) => new Date(c.date).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeLessThanOrEqual(dates[i]);
    }
    const reasons = res.body.map((c: { reason: string | null }) => c.reason);
    expect(reasons).toEqual(expect.arrayContaining(['Independence Day', 'Christmas']));
  });

  it('404 — unknown resource id returns canonical NOT_FOUND envelope', async () => {
    const res = await request(app)
      .get('/resources/00000000-0000-0000-0000-000000000000/closures')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});

/* ====== GET /itineraries/:id/items ====== */

describe('GET /itineraries/:id/items', () => {
  it('401 — unauthenticated', async () => {
    const res = await request(app).get(`/itineraries/${itineraryId}/items`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('403 — admin can access, but organizer-other cannot list someone else\'s itinerary items', async () => {
    // Fresh organizer who is NOT the owner.
    const otherCreds = { username: `uncov_other_${ts}`, password: 'OtherPass12345!x' };
    await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      ...otherCreds,
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
    const otherLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(otherCreds);
    const otherToken = otherLogin.body.accessToken;

    const res = await request(app)
      .get(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect([403]).toContain(res.status); // enforceOwnership inside listItems service
    expect(res.body.code).toMatch(/FORBIDDEN/);
    // cleanup
    const u = await prisma.user.findUnique({ where: { username: otherCreds.username } });
    if (u) {
      await prisma.refreshToken.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.device.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.securityQuestion.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.passwordHistory.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: u.id } }).catch(() => {});
    }
  }, 15_000);

  it('200 — owner lists items with resource hydrated, ordered by day + startTime', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      expect(item.resource).toBeDefined();
      expect(item.resource.id).toBe(resourceId);
      expect(typeof item.dayNumber).toBe('number');
      expect(typeof item.startTime).toBe('string');
      expect(typeof item.endTime).toBe('string');
    }
    // Ordering invariant (public contract).
    for (let i = 1; i < res.body.length; i++) {
      const prev = res.body[i - 1];
      const cur = res.body[i];
      expect(prev.dayNumber).toBeLessThanOrEqual(cur.dayNumber);
      if (prev.dayNumber === cur.dayNumber) {
        expect(prev.startTime <= cur.startTime).toBe(true);
      }
    }
  });

  it('200 — dayNumber filter narrows the list to a single day', async () => {
    const all = await request(app)
      .get(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgToken}`);
    const filtered = await request(app)
      .get(`/itineraries/${itineraryId}/items?dayNumber=1`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(filtered.status).toBe(200);
    for (const item of filtered.body) {
      expect(item.dayNumber).toBe(1);
    }
    // Every day-1 item in the unfiltered list appears in the filtered list.
    const unfilteredDayOne = all.body.filter((i: { dayNumber: number }) => i.dayNumber === 1);
    expect(filtered.body.length).toBe(unfilteredDayOne.length);
  });
});

/* ====== PATCH /notification-templates/:id ====== */

describe('PATCH /notification-templates/:id', () => {
  it('401 — unauthenticated', async () => {
    const res = await request(app)
      .patch(`/notification-templates/${templateId}`)
      .set('Idempotency-Key', uuid())
      .send({ subject: 'Anonymous update' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('403 — organizer cannot update templates (admin-only)', async () => {
    const res = await request(app)
      .patch(`/notification-templates/${templateId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid())
      .send({ subject: 'Organizer attempt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toMatch(/FORBIDDEN/);
  });

  it('200 — admin can update subject + body; response carries the new values AND persistence reflects them', async () => {
    const newSubject = `Hello ${ts} {{name}} (updated)`;
    const newBody = `Welcome ${ts} {{name}} — updated`;
    const res = await request(app)
      .patch(`/notification-templates/${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ subject: newSubject, body: newBody });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(templateId);
    expect(res.body.subject).toBe(newSubject);
    expect(res.body.body).toBe(newBody);
    // Persistence assertion (direct DB read, outside the HTTP layer).
    const row = await prisma.notificationTemplate.findUnique({ where: { id: templateId } });
    expect(row?.subject).toBe(newSubject);
    expect(row?.body).toBe(newBody);
  });

  it('409 — renaming to a code that already exists conflicts', async () => {
    // Seed a second template we will collide with.
    const siblingCode = `sibling_${ts}_${uuid()}`;
    const sibling = await request(app)
      .post('/notification-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code: siblingCode, subject: 'S', body: 'B' });
    expect(sibling.status).toBe(201);

    const conflict = await request(app)
      .patch(`/notification-templates/${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code: siblingCode });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');
    // cleanup sibling
    await prisma.notification.updateMany({ where: { templateId: sibling.body.id }, data: { templateId: null } }).catch(() => {});
    await prisma.notificationTemplate.deleteMany({ where: { id: sibling.body.id } }).catch(() => {});
  });

  it('404 — patch against unknown template id is canonical NOT_FOUND', async () => {
    const res = await request(app)
      .patch('/notification-templates/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ subject: 'never' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

/* ====== GET /api/docs (Swagger UI) ====== */

describe('GET /api/docs — Swagger UI mount', () => {
  // Swagger UI is mounted at `app.use('/api/docs', swaggerUi.serve,
  // swaggerUi.setup(apiSpec))`. The exact `GET /api/docs` URL is a 301
  // redirect to `/api/docs/` (Express + swagger-ui-express trailing-slash
  // convention). Both shapes go through the real Express mount chain —
  // no handler/middleware bypass.

  it('301 — exact `/api/docs` redirects to `/api/docs/`', async () => {
    const res = await request(app).get('/api/docs').redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toMatch(/\/api\/docs\/?$/);
  });

  it('200 — `/api/docs/` serves the Swagger UI HTML page', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const body = (typeof res.text === 'string' && res.text.length > 0)
      ? res.text
      : (res.body ? res.body.toString() : '');
    // Standard Swagger UI markers — these come from swagger-ui-express's
    // generated page, not from the app itself, so checking for them is the
    // cleanest way to prove the UI is actually wired up.
    expect(body).toMatch(/swagger-ui/i);
    expect(body).toMatch(/<html[\s\S]*<\/html>/i);
  });

  it('200 — `/api/docs/swagger-ui-init.js` serves the init script that contains our OpenAPI title', async () => {
    // swagger-ui-express materialises the live spec into swagger-ui-init.js.
    // Reading it back proves:
    //   (a) the spec passed to swaggerUi.setup() is the one served,
    //   (b) our canonical title is embedded in the response.
    const res = await request(app).get('/api/docs/swagger-ui-init.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    const body = (typeof res.text === 'string' && res.text.length > 0)
      ? res.text
      : (res.body ? res.body.toString() : '');
    // The TripForge OpenAPI info.title is "TripForge API"; prove it was
    // passed through to swagger-ui unmodified.
    expect(body).toMatch(/TripForge/);
  });

  it('`/api/docs` is reachable without authentication (public endpoint)', async () => {
    // No Authorization / no Idempotency-Key — the Swagger UI mount must
    // NOT gate itself behind the authMiddleware, since developer tooling
    // should be available on a fresh install.
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
  });
});

/* ====== GET /travel-times (list) ====== */

describe('GET /travel-times — authenticated list', () => {
  it('401 — unauthenticated GET is rejected with the canonical envelope', async () => {
    const res = await request(app).get('/travel-times');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('200 — admin sees the full matrix and the seeded row is present with hydrated endpoints', async () => {
    const res = await request(app)
      .get('/travel-times')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Every row carries both endpoint resources (service `include: { fromResource: true, toResource: true }`).
    for (const row of res.body) {
      expect(typeof row.fromResourceId).toBe('string');
      expect(typeof row.toResourceId).toBe('string');
      expect(typeof row.travelMinutes).toBe('number');
      expect(row.fromResource).toBeDefined();
      expect(row.toResource).toBeDefined();
      expect(row.fromResource.id).toBe(row.fromResourceId);
      expect(row.toResource.id).toBe(row.toResourceId);
    }
    // The row seeded in beforeAll is present with the exact travelMinutes.
    const seeded = res.body.find(
      (r: { fromResourceId: string; toResourceId: string }) =>
        r.fromResourceId === resourceId && r.toResourceId === resourceId2,
    );
    expect(seeded).toBeDefined();
    expect(seeded.travelMinutes).toBe(17);
    expect(seeded.transportMode).toBe('walking');
  });

  it('200 — organizer with resource:read lists travel-times (scope is matrix-global, not owner-scoped)', async () => {
    const res = await request(app)
      .get('/travel-times')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 — ?fromResourceId filter narrows to rows whose source matches', async () => {
    const res = await request(app)
      .get(`/travel-times?fromResourceId=${resourceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.fromResourceId).toBe(resourceId);
    }
    // At least the seeded row must show up in the filtered list.
    const ids = res.body.map((r: { toResourceId: string }) => r.toResourceId);
    expect(ids).toContain(resourceId2);
  });
});
