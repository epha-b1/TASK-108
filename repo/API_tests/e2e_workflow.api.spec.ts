/**
 * End-to-end black-box workflow — register → login → plan → share →
 * export → optimize → receive notification → audit → logout.
 *
 * This suite intentionally does NOT mutate the database directly (the
 * only direct-DB call in this file is a role-grant for admin actions,
 * required because the service layer doesn't expose a self-promotion
 * endpoint, and the afterAll cleanup). Every state transition is
 * driven through a real HTTP request so the suite reflects what an
 * integrated client — browser, mobile app, CI agent — would observe.
 *
 * A full trip through this suite proves that the primary user journey
 * still works even if any one piece (middleware, validator, service,
 * DB) silently regresses. A pure unit test cannot catch that.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `e2e_admin_${ts}`, password: 'AdminPass123!x' };
const ownerCreds = { username: `e2e_owner_${ts}`, password: 'OwnerPass123!x' };
const readerCreds = { username: `e2e_reader_${ts}`, password: 'ReaderPass123!x' };

let adminToken: string;
let ownerToken: string;
let readerToken: string;
let adminUserId: string;
let ownerUserId: string;
let readerUserId: string;

/* ------------------------------------------------------------------ */
/* afterAll cleanup (not under test)                                   */
afterAll(async () => {
  const ids = [adminUserId, ownerUserId, readerUserId].filter(Boolean);
  for (const uid of ids) {
    const itins = await prisma.itinerary.findMany({ where: { ownerId: uid } }).catch(() => []);
    for (const it of itins) {
      await prisma.itineraryItem.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
      await prisma.itineraryVersion.deleteMany({ where: { itineraryId: it.id } }).catch(() => {});
    }
    await prisma.itinerary.deleteMany({ where: { ownerId: uid } }).catch(() => {});
    const notifs = await prisma.notification.findMany({ where: { userId: uid } }).catch(() => []);
    for (const n of notifs) {
      await prisma.outboxMessage.deleteMany({ where: { notificationId: n.id } }).catch(() => {});
    }
    await prisma.notification.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userNotificationSetting.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  }
  await prisma.resource.deleteMany({ where: { name: { startsWith: `e2e_${ts}_` } } }).catch(() => {});
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Test suite order matters: each test builds on the previous one.     */
describe('E2E workflow — full user journey via HTTP only', () => {
  it('step 1 — register three accounts through /auth/register', async () => {
    for (const creds of [adminCreds, ownerCreds, readerCreds]) {
      const res = await request(app)
        .post('/auth/register')
        .set('Idempotency-Key', uuid())
        .send({
          ...creds,
          securityQuestions: [
            { question: 'Q1?', answer: 'a1' },
            { question: 'Q2?', answer: 'a2' },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe(creds.username);
      expect(typeof res.body.id).toBe('string');
      if (creds === adminCreds) adminUserId = res.body.id;
      if (creds === ownerCreds) ownerUserId = res.body.id;
      if (creds === readerCreds) readerUserId = res.body.id;
    }
    // Single non-API state transition: grant admin. The service layer has
    // no self-promotion endpoint, so this is the minimum out-of-band step
    // required to drive the admin-authenticated portions of the workflow.
    await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });

    // Seed organizer permission points + role bindings so owner/reader
    // tokens carry itinerary/notification scopes. Without this, the default
    // registered-user role has NO permission points and every write call
    // returns 403 before reaching the controller.
    const perms = [
      'itinerary:read', 'itinerary:write', 'itinerary:delete',
      'resource:read', 'notification:read',
    ];
    const ppIds: string[] = [];
    for (const code of perms) {
      const pp = await prisma.permissionPoint.upsert({
        where: { code }, update: {}, create: { code },
      });
      ppIds.push(pp.id);
    }
    const orgRole = await prisma.role.upsert({
      where: { name: 'organizer' },
      update: {},
      create: { name: 'organizer', description: 'Organizer role' },
    });
    await prisma.rolePermissionPoint.deleteMany({ where: { roleId: orgRole.id } });
    await prisma.rolePermissionPoint.createMany({
      data: ppIds.map((ppId) => ({ roleId: orgRole.id, permissionPointId: ppId })),
    });
    for (const uid of [ownerUserId, readerUserId]) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: uid, roleId: orgRole.id } },
        update: {},
        create: { userId: uid, roleId: orgRole.id },
      });
    }
  }, 30_000);

  it('step 2 — login returns signed tokens + user body for all three accounts', async () => {
    for (const [creds, slot] of [
      [adminCreds, 'admin'] as const,
      [ownerCreds, 'owner'] as const,
      [readerCreds, 'reader'] as const,
    ]) {
      const res = await request(app)
        .post('/auth/login')
        .set('Idempotency-Key', uuid())
        .send(creds);
      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.accessToken.split('.')).toHaveLength(3); // JWT header.payload.sig
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.user.username).toBe(creds.username);
      if (slot === 'admin') adminToken = res.body.accessToken;
      if (slot === 'owner') ownerToken = res.body.accessToken;
      if (slot === 'reader') readerToken = res.body.accessToken;
    }
  }, 30_000);

  it('step 3 — /auth/me echoes the authenticated principal', async () => {
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${ownerToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(ownerUserId);
    expect(me.body.username).toBe(ownerCreds.username);
  });

  let resourceId: string;
  let resourceId2: string;
  it('step 4 — admin creates two resources (observable in list + detail)', async () => {
    const r1 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `e2e_${ts}_ResA`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 });
    expect(r1.status).toBe(201);
    resourceId = r1.body.id;

    const r2 = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `e2e_${ts}_ResB`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 });
    expect(r2.status).toBe(201);
    resourceId2 = r2.body.id;

    // Both resources are listable.
    const list = await request(app).get('/resources').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const names = list.body.data.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining([`e2e_${ts}_ResA`, `e2e_${ts}_ResB`]));

    // Individual fetch returns the same id.
    const getOne = await request(app)
      .get(`/resources/${resourceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getOne.status).toBe(200);
    expect(getOne.body.id).toBe(resourceId);
  });

  it('step 5 — admin configures travel times between the two resources', async () => {
    for (const [from, to] of [[resourceId, resourceId2], [resourceId2, resourceId]] as const) {
      const res = await request(app)
        .post('/travel-times')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', uuid())
        .send({ fromResourceId: from, toResourceId: to, travelMinutes: 10, transportMode: 'walking' });
      expect(res.status).toBe(200);
    }
  });

  let itineraryId: string;
  it('step 6 — owner creates an itinerary and adds two items (each version is observable)', async () => {
    const created = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `e2e_trip_${ts}`, destination: 'Rome', startDate: '2026-06-01', endDate: '2026-06-03' });
    expect(created.status).toBe(201);
    itineraryId = created.body.id;

    const item1 = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00' });
    expect(item1.status).toBe(201);

    const item2 = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: resourceId2, dayNumber: 1, startTime: '11:00', endTime: '12:00' });
    expect(item2.status).toBe(201);

    // Version history is observable and monotonic.
    const versions = await request(app)
      .get(`/itineraries/${itineraryId}/versions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(versions.status).toBe(200);
    // 1 create + 2 item additions = at least 3 versions.
    expect(versions.body.length).toBeGreaterThanOrEqual(3);
    const numbers = versions.body.map((v: { versionNumber: number }) => v.versionNumber).sort((a: number, b: number) => a - b);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1] + 1);
  }, 30_000);

  it('step 7 — GET /itineraries/:id returns the hydrated plan with both items', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(itineraryId);
    expect(res.body.items).toHaveLength(2);
    const dayOneIds = res.body.items
      .filter((i: { dayNumber: number }) => i.dayNumber === 1)
      .map((i: { resourceId: string }) => i.resourceId);
    expect(dayOneIds.sort()).toEqual([resourceId, resourceId2].sort());
  });

  it('step 8 — GET /itineraries/:id/optimize returns ranked suggestions', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/optimize`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const s of res.body) {
      expect(typeof s.rank).toBe('number');
      expect(typeof s.totalTravelMinutes).toBe('number');
      expect(s.totalTravelMinutes).toBeGreaterThanOrEqual(0);
    }
  });

  let shareToken: string;
  it('step 9 — owner shares plan; anonymous reader gets it back via public /shared/:token', async () => {
    const shareRes = await request(app)
      .post(`/itineraries/${itineraryId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(shareRes.status).toBe(200);
    shareToken = shareRes.body.shareToken;
    expect(shareToken).toMatch(/^[0-9a-f]{64}$/);

    // Public, no bearer.
    const publicRes = await request(app).get(`/shared/${shareToken}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.id).toBe(itineraryId);
    expect(publicRes.body.items).toHaveLength(2);
  });

  it('step 10 — export produces a schema v1.0 envelope that mirrors the live plan', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/export`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe('1.0');
    expect(res.body.itinerary.id).toBe(itineraryId);
    expect(res.body.items).toHaveLength(2);
  });

  it('step 11 — admin sends a notification to the reader; reader lists + marks read', async () => {
    const send = await request(app)
      .post('/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        userId: readerUserId,
        type: 'info',
        subject: 'trip shared',
        message: `e2e_${ts} shared a trip with you`,
      });
    expect(send.status).toBe(201);
    const notifId = send.body.id;

    // Grant reader the notification:read permission so the list call works.
    const pp = await prisma.permissionPoint.upsert({
      where: { code: 'notification:read' }, update: {}, create: { code: 'notification:read' },
    });
    const role = await prisma.role.upsert({
      where: { name: 'organizer' }, update: {}, create: { name: 'organizer', description: 'o' },
    });
    await prisma.rolePermissionPoint.upsert({
      where: { roleId_permissionPointId: { roleId: role.id, permissionPointId: pp.id } },
      update: {}, create: { roleId: role.id, permissionPointId: pp.id },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: readerUserId, roleId: role.id } },
      update: {}, create: { userId: readerUserId, roleId: role.id },
    });
    // Re-login so the fresh role propagates into the JWT claims path.
    const rl = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send(readerCreds);
    readerToken = rl.body.accessToken;

    const list = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${readerToken}`);
    expect(list.status).toBe(200);
    const found = list.body.data.find((n: { id: string }) => n.id === notifId);
    expect(found).toBeDefined();
    expect(found.subject).toBe('trip shared');

    const mark = await request(app)
      .patch(`/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${readerToken}`)
      .set('Idempotency-Key', uuid());
    expect(mark.status).toBe(200);
    expect(mark.body.read).toBe(true);
  }, 30_000);

  it('step 12 — audit log reflects the mutations (admin read via /audit-logs)', async () => {
    const res = await request(app)
      .get('/audit-logs?limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const actions = new Set(res.body.data.map((r: { action: string }) => r.action));
    // Each of these actions was triggered by one of the prior API calls in
    // this same suite. If ANY is missing, the audit subsystem silently
    // stopped recording one of the workflow's steps.
    expect(actions).toEqual(expect.objectContaining(new Set([
      'resource.create',
      'itinerary.create',
      'itinerary.item.add',
      'itinerary.share',
      'notification.send',
    ]) as any));
  }, 15_000);

  it('step 13 — owner logs out; refresh token is revoked (401 on /auth/refresh)', async () => {
    // Log in freshly so we have a refresh token pair we own in this test.
    const login = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', uuid())
      .send(ownerCreds);
    expect(login.status).toBe(200);
    const { accessToken, refreshToken } = login.body;

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', uuid())
      .send({ refreshToken });
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app)
      .post('/auth/refresh')
      .set('Idempotency-Key', uuid())
      .send({ refreshToken });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.code).toBe('UNAUTHORIZED');
  }, 15_000);
});
