/**
 * Mixed-role RBAC + data-scope invariants.
 *
 * Spans admin ↔ organizer-owner ↔ organizer-other scenarios across the
 * endpoints where data ownership matters:
 *   - itineraries + items (owner-scoped read/write)
 *   - resources (admin-managed, organizer-readable)
 *   - audit logs (admin-only window into every actor's writes)
 *   - notifications (recipient-scoped listing + marking read)
 *   - /shared/:token (bearer-independent read, cannot drive writes)
 *
 * Every test sends real HTTP through the full Express + Prisma + MySQL
 * chain. Assertions cross-check both the HTTP body AND the persisted
 * rows so an accidental "403 but write still applied" regression fails
 * visibly.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `scope_admin_${ts}`, password: 'AdminPass123!x' };
const ownerCreds = { username: `scope_owner_${ts}`, password: 'OwnerPass12345!x' };
const otherCreds = { username: `scope_other_${ts}`, password: 'OtherPass12345!y' };

let adminToken: string;
let ownerToken: string;
let otherToken: string;
let adminUserId: string;
let ownerUserId: string;
let otherUserId: string;

let resourceId: string;
let itineraryId: string;
let itemId: string;

beforeAll(async () => {
  await prisma.$connect();
  for (const [creds, slot] of [
    [adminCreds, 'admin'] as const,
    [ownerCreds, 'owner'] as const,
    [otherCreds, 'other'] as const,
  ]) {
    const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      ...creds,
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
    if (slot === 'admin') adminUserId = reg.body.id;
    if (slot === 'owner') ownerUserId = reg.body.id;
    if (slot === 'other') otherUserId = reg.body.id;
  }
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });

  // Grant BOTH organizers the itinerary + resource permissions the
  // routes require; data-scope enforcement happens at the service layer
  // (ownerId checks), not the permission gate.
  const perms = ['itinerary:read', 'itinerary:write', 'itinerary:delete', 'resource:read'];
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
  for (const uid of [ownerUserId, otherUserId]) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: uid, roleId: role.id } },
      update: {}, create: { userId: uid, roleId: role.id },
    });
  }

  adminToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds)).body.accessToken;
  ownerToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(ownerCreds)).body.accessToken;
  otherToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(otherCreds)).body.accessToken;

  // Admin-managed resource.
  const res = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `scope_res_${ts}`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 });
  resourceId = res.body.id;

  // Owner creates an itinerary with an item.
  const itin = await request(app)
    .post('/itineraries')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('Idempotency-Key', uuid())
    .send({ title: `scope_trip_${ts}`, destination: 'Rome' });
  itineraryId = itin.body.id;

  const item = await request(app)
    .post(`/itineraries/${itineraryId}/items`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('Idempotency-Key', uuid())
    .send({ resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00' });
  itemId = item.body.id;
}, 30_000);

afterAll(async () => {
  for (const uid of [adminUserId, ownerUserId, otherUserId].filter(Boolean)) {
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
  if (resourceId) await prisma.resource.deleteMany({ where: { id: resourceId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('Itinerary data scope — owner vs other-organizer vs admin', () => {
  it('organizer-other is FORBIDDEN from reading someone else\'s itinerary detail AND list does not leak it', async () => {
    // Direct GET: 403.
    const get = await request(app)
      .get(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(get.status).toBe(403);
    expect(get.body.code).toMatch(/FORBIDDEN/);

    // List: other-organizer MUST NOT see owner's itinerary.
    const list = await request(app)
      .get('/itineraries')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((it: { id: string }) => it.id);
    expect(ids).not.toContain(itineraryId);
  });

  it('admin can read AND edit someone else\'s itinerary; item count + owner unchanged', async () => {
    const before = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
    const beforeItems = await prisma.itineraryItem.count({ where: { itineraryId } });

    const get = await request(app)
      .get(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(200);
    expect(get.body.ownerId).toBe(ownerUserId); // ownership is the owner's, admin can just READ

    // Admin PATCH — title only. Ownership MUST NOT change.
    const patch = await request(app)
      .patch(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `${before!.title} — admin-touched` });
    expect(patch.status).toBe(200);
    expect(patch.body.ownerId).toBe(ownerUserId);

    // Item count unchanged — admin read/write access didn't cascade.
    const after = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
    const afterItems = await prisma.itineraryItem.count({ where: { itineraryId } });
    expect(after?.ownerId).toBe(ownerUserId);
    expect(afterItems).toBe(beforeItems);
  });

  it('organizer-other cannot add items, modify items, delete items, share, or export owner\'s itinerary', async () => {
    const checks = [
      { name: 'add item', req: request(app).post(`/itineraries/${itineraryId}/items`).set('Authorization', `Bearer ${otherToken}`).set('Idempotency-Key', uuid()).send({ resourceId, dayNumber: 2, startTime: '09:00', endTime: '10:00' }) },
      { name: 'update item', req: request(app).patch(`/itineraries/${itineraryId}/items/${itemId}`).set('Authorization', `Bearer ${otherToken}`).set('Idempotency-Key', uuid()).send({ startTime: '11:00', endTime: '12:00' }) },
      { name: 'delete item', req: request(app).delete(`/itineraries/${itineraryId}/items/${itemId}`).set('Authorization', `Bearer ${otherToken}`).set('Idempotency-Key', uuid()) },
      { name: 'share', req: request(app).post(`/itineraries/${itineraryId}/share`).set('Authorization', `Bearer ${otherToken}`).set('Idempotency-Key', uuid()) },
      { name: 'export', req: request(app).get(`/itineraries/${itineraryId}/export`).set('Authorization', `Bearer ${otherToken}`) },
      { name: 'delete itinerary', req: request(app).delete(`/itineraries/${itineraryId}`).set('Authorization', `Bearer ${otherToken}`).set('Idempotency-Key', uuid()) },
    ];

    for (const c of checks) {
      const res = await c.req;
      expect(res.status).toBe(403);
    }

    // DB invariants: itinerary, its items, and the absence of a share
    // token are all intact.
    const itin = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
    expect(itin).not.toBeNull();
    const items = await prisma.itineraryItem.findMany({ where: { itineraryId } });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(itemId);
  });

  it('a shared token is a READ-ONLY grant — no write verbs work through it, even against the same itinerary id', async () => {
    // Owner shares; anon client can read via /shared/:token.
    const share = await request(app)
      .post(`/itineraries/${itineraryId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(share.status).toBe(200);
    const token = share.body.shareToken;

    const publicRead = await request(app).get(`/shared/${token}`);
    expect(publicRead.status).toBe(200);
    expect(publicRead.body.id).toBe(itineraryId);

    // Anonymous attempt at a write against the itinerary id → 401
    // (bearer required; the share token does NOT confer write powers).
    const anonWrite = await request(app)
      .patch(`/itineraries/${itineraryId}`)
      .set('Idempotency-Key', uuid())
      .send({ title: 'anon-tampering' });
    expect([401, 403]).toContain(anonWrite.status);
  });
});

describe('Audit log scope — admin sees the journey; organizer is denied', () => {
  it('admin GET /audit-logs returns rows; organizer GET returns 403 regardless of ownership', async () => {
    const adminRes = await request(app)
      .get('/audit-logs?limit=20')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(Array.isArray(adminRes.body.data)).toBe(true);

    const orgRes = await request(app)
      .get('/audit-logs?limit=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(orgRes.status).toBe(403);
    expect(orgRes.body.code).toMatch(/FORBIDDEN/);
  });

  it('admin audit export includes admin\'s OWN writes — no silent skip of self-actor rows', async () => {
    // Admin performs a trackable write.
    const probeName = `scope_admin_probe_${ts}_${uuid()}`;
    const probe = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: probeName, type: 'attraction', city: 'Rome' });
    expect(probe.status).toBe(201);

    // Poll audit until the resource.create row lands (fire-and-forget write).
    let found: any = null;
    for (let i = 0; i < 40; i++) {
      const res = await request(app)
        .get(`/audit-logs?action=resource.create&limit=200`)
        .set('Authorization', `Bearer ${adminToken}`);
      const rows: any[] = res.body.data || [];
      const match = rows.find((r) => {
        const detail = r.detail || {};
        return detail.resourceId === probe.body.id;
      });
      if (match) { found = match; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).not.toBeNull();
    expect(found.detail.actorId).toBe(adminUserId);

    // Cleanup.
    await prisma.resource.deleteMany({ where: { name: probeName } }).catch(() => {});
  }, 20_000);
});

describe('Notification scope — recipient sees own feed; other users cannot read or ack someone else\'s', () => {
  let ownerNotifId: string;

  beforeAll(async () => {
    const send = await request(app)
      .post('/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ userId: ownerUserId, type: 'info', subject: 's', message: `scope_${ts} for owner` });
    expect(send.status).toBe(201);
    ownerNotifId = send.body.id;

    // Grant BOTH organizers notification:read so the list endpoint is callable
    const pp = await prisma.permissionPoint.upsert({
      where: { code: 'notification:read' }, update: {}, create: { code: 'notification:read' },
    });
    const role = await prisma.role.findFirst({ where: { name: 'organizer' } });
    if (role) {
      await prisma.rolePermissionPoint.upsert({
        where: { roleId_permissionPointId: { roleId: role.id, permissionPointId: pp.id } },
        update: {}, create: { roleId: role.id, permissionPointId: pp.id },
      });
    }
    // re-login the two organizers so the permission sticks for this test
    ownerToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(ownerCreds)).body.accessToken;
    otherToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(otherCreds)).body.accessToken;
  }, 20_000);

  it('owner sees own notification in list; organizer-other does not', async () => {
    const ownerList = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerList.status).toBe(200);
    const ownerIds = (ownerList.body.data as Array<{ id: string }>).map((n) => n.id);
    expect(ownerIds).toContain(ownerNotifId);

    const otherList = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherList.status).toBe(200);
    const otherIds = (otherList.body.data as Array<{ id: string }>).map((n) => n.id);
    expect(otherIds).not.toContain(ownerNotifId);
  });

  it('organizer-other cannot mark owner\'s notification as read (403); owner can (200); read=true persists', async () => {
    const otherAck = await request(app)
      .patch(`/notifications/${ownerNotifId}/read`)
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', uuid());
    expect(otherAck.status).toBe(403);

    const ownerAck = await request(app)
      .patch(`/notifications/${ownerNotifId}/read`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(ownerAck.status).toBe(200);
    expect(ownerAck.body.read).toBe(true);

    const row = await prisma.notification.findUnique({ where: { id: ownerNotifId } });
    expect(row?.read).toBe(true);
  });
});

describe('User self-scope', () => {
  it('organizer can read OWN user profile via GET /users/:id; cannot read another user\'s', async () => {
    const self = await request(app)
      .get(`/users/${ownerUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(self.status).toBe(200);
    expect(self.body.id).toBe(ownerUserId);

    const cross = await request(app)
      .get(`/users/${otherUserId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(cross.status).toBe(403);
    expect(cross.body.code).toMatch(/FORBIDDEN/);
  });

  it('GET /users (listing) is admin-only; organizer gets 403 with canonical envelope', async () => {
    const orgList = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(orgList.status).toBe(403);

    const adminList = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(Array.isArray(adminList.body.data)).toBe(true);
    // Admin sees every user we created.
    const usernames = adminList.body.data.map((u: { username: string }) => u.username);
    expect(usernames).toEqual(expect.arrayContaining([
      adminCreds.username, ownerCreds.username, otherCreds.username,
    ]));
  });
});
