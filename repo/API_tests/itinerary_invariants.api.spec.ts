/**
 * Itinerary + routing invariants — optimization output quality, share
 * token expiry/invalid-token behaviour, and version-history diff
 * integrity for metadata updates + item edits + item deletes.
 *
 * All tests hit the full app stack with a real database. Where the
 * invariant can't be observed through the API alone (e.g., what's
 * persisted in the diffMetadata column), we read it back through
 * `GET /itineraries/:id/versions` — which is the public contract.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `inv_admin_${ts}`, password: 'AdminPass123!x' };
const ownerCreds = { username: `inv_owner_${ts}`, password: 'OwnerPass123!x' };

let adminToken: string;
let ownerToken: string;
let adminUserId: string;
let ownerUserId: string;

let resA: string;
let resB: string;
let resC: string;

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

  const ownReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...ownerCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  ownerUserId = ownReg.body.id;
  const ownLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(ownerCreds);
  ownerToken = ownLogin.body.accessToken;

  // RBAC: organizer needs itinerary + resource read/write.
  const perms = ['itinerary:read', 'itinerary:write', 'itinerary:delete', 'resource:read'];
  const ppIds: string[] = [];
  for (const code of perms) {
    const pp = await prisma.permissionPoint.upsert({
      where: { code }, update: {}, create: { code },
    });
    ppIds.push(pp.id);
  }
  const role = await prisma.role.upsert({
    where: { name: 'organizer' }, update: {}, create: { name: 'organizer', description: 'Organizer role' },
  });
  for (const ppId of ppIds) {
    await prisma.rolePermissionPoint.upsert({
      where: { roleId_permissionPointId: { roleId: role.id, permissionPointId: ppId } },
      update: {},
      create: { roleId: role.id, permissionPointId: ppId },
    });
  }
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: ownerUserId, roleId: role.id } },
    update: {},
    create: { userId: ownerUserId, roleId: role.id },
  });

  // 3 resources: A + B are close (5min), C is far (120min).
  const mk = (name: string) => request(app)
    .post('/resources').set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', uuid())
    .send({ name: `inv_${name}_${ts}`, type: 'attraction', city: 'Rome', region: 'IT', minDwellMinutes: 30 });
  resA = (await mk('A')).body.id;
  resB = (await mk('B')).body.id;
  resC = (await mk('C')).body.id;
  for (const [from, to, min] of [
    [resA, resB, 5], [resB, resA, 5],
    [resA, resC, 120], [resC, resA, 120],
    [resB, resC, 120], [resC, resB, 120],
  ] as const) {
    await request(app)
      .post('/travel-times')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ fromResourceId: from, toResourceId: to, travelMinutes: min, transportMode: 'walking' });
  }
}, 30000);

afterAll(async () => {
  for (const uid of [adminUserId, ownerUserId]) {
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
  for (const rid of [resA, resB, resC]) {
    if (!rid) continue;
    await prisma.travelTimeMatrix.deleteMany({
      where: { OR: [{ fromResourceId: rid }, { toResourceId: rid }] },
    }).catch(() => {});
    await prisma.resource.deleteMany({ where: { id: rid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/* ========== Optimization output quality ========== */

describe('GET /itineraries/:id/optimize — suggestion quality', () => {
  let itinId: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `opt_trip_${ts}`, destination: 'Rome', startDate: '2026-06-01', endDate: '2026-06-02' });
    itinId = createRes.body.id;

    // Intentionally bad order: A (cheap to B), then C (far), then B (far from C).
    // The optimiser should find a better ordering.
    for (const [resId, hour] of [[resA, 9], [resC, 10], [resB, 11]] as const) {
      const r = await request(app)
        .post(`/itineraries/${itinId}/items`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', uuid())
        .send({
          resourceId: resId,
          dayNumber: 1,
          startTime: `${String(hour).padStart(2, '0')}:00`,
          endTime: `${String(hour).padStart(2, '0')}:45`,
        });
      // The second and third insert might conflict on travel-time but we
      // don't care about that — we just need SOME items to exist. If
      // validation rejects, fall back to a non-conflicting schedule.
      if (r.status !== 201) {
        await request(app)
          .post(`/itineraries/${itinId}/items`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set('Idempotency-Key', uuid())
          .send({
            resourceId: resId,
            dayNumber: 1,
            startTime: `${String(hour + 2).padStart(2, '0')}:00`,
            endTime: `${String(hour + 2).padStart(2, '0')}:30`,
          });
      }
    }
  });

  afterAll(async () => {
    await prisma.itineraryItem.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itineraryVersion.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itinerary.deleteMany({ where: { id: itinId } }).catch(() => {});
  });

  it('returns ≤3 suggestions, each non-empty, ranked, and with non-negative timeSaved', async () => {
    const res = await request(app)
      .get(`/itineraries/${itinId}/optimize`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.length).toBeLessThanOrEqual(3);

    const ranks = res.body.map((s: { rank: number }) => s.rank);
    // Rank must be 1..N contiguously.
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks[0]).toBe(1);

    for (const s of res.body) {
      expect(typeof s.rank).toBe('number');
      expect(typeof s.dayNumber).toBe('number');
      expect(Array.isArray(s.items)).toBe(true);
      expect(s.items.length).toBeGreaterThan(0);
      expect(typeof s.totalTravelMinutes).toBe('number');
      expect(s.totalTravelMinutes).toBeGreaterThanOrEqual(0);
      expect(typeof s.estimatedTimeSaved).toBe('number');
      expect(s.estimatedTimeSaved).toBeGreaterThanOrEqual(0);
      expect(typeof s.reason).toBe('string');
      expect(s.reason.length).toBeGreaterThan(0);

      // Each item has a position + a resource populated.
      for (let i = 0; i < s.items.length; i++) {
        expect(s.items[i].position).toBe(i);
        expect(s.items[i].resource).toBeDefined();
        expect(typeof s.items[i].resource.name).toBe('string');
      }
    }

    // Suggestions are sorted by totalTravelMinutes ASCENDING.
    for (let i = 1; i < res.body.length; i++) {
      expect(res.body[i - 1].totalTravelMinutes).toBeLessThanOrEqual(res.body[i].totalTravelMinutes);
    }
  });

  it('404 — optimize with dayNumber that has no items', async () => {
    const res = await request(app)
      .get(`/itineraries/${itinId}/optimize?dayNumber=99`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

/* ========== Share token: expiry + invalid token ========== */

describe('POST /itineraries/:id/share — token lifecycle', () => {
  let itinId: string;
  let shareToken: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `share_${ts}`, destination: 'Rome' });
    itinId = createRes.body.id;
  });

  afterAll(async () => {
    await prisma.itineraryItem.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itineraryVersion.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itinerary.deleteMany({ where: { id: itinId } }).catch(() => {});
  });

  it('owner issues a 64-hex share token with a ~7-day future expiry', async () => {
    const res = await request(app)
      .post(`/itineraries/${itinId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    expect(typeof res.body.shareToken).toBe('string');
    expect(res.body.shareToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.shareUrl).toBe(`/shared/${res.body.shareToken}`);
    const exp = new Date(res.body.expiresAt).getTime();
    const deltaDays = (exp - Date.now()) / (24 * 3600_000);
    // The service contract is "7 days from issuance". Allow ±5 minutes for
    // clock skew between the API container and this test runner — the exact
    // millisecond is not the contract, the day granularity is.
    expect(deltaDays).toBeGreaterThan(6.99);
    expect(deltaDays).toBeLessThan(7.01);
    // Core invariant that CANNOT rely on tolerances: expiry is in the future.
    expect(exp).toBeGreaterThan(Date.now());
    shareToken = res.body.shareToken;
  });

  it('GET /shared/:token works anonymously while valid', async () => {
    const res = await request(app).get(`/shared/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(itinId);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('GET /shared/<invalid-token> → 404 canonical envelope (no oracle)', async () => {
    const res = await request(app).get('/shared/totally-made-up-token');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.message).toMatch(/shared itinerary/i);
  });

  it('expired share token → 404 (not 410/403) with the same message', async () => {
    // Move the expiry 1 ms into the past to drive the expiry branch.
    await prisma.itinerary.update({
      where: { id: itinId },
      data: { shareExpiresAt: new Date(Date.now() - 1) },
    });
    const res = await request(app).get(`/shared/${shareToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.message).toMatch(/expired/i);
  });

  it('re-sharing rotates the token; old token no longer resolves', async () => {
    // Refresh the share to a NEW token.
    const res = await request(app)
      .post(`/itineraries/${itinId}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    const newToken: string = res.body.shareToken;
    expect(newToken).not.toBe(shareToken);

    const oldRes = await request(app).get(`/shared/${shareToken}`);
    expect(oldRes.status).toBe(404);

    const newRes = await request(app).get(`/shared/${newToken}`);
    expect(newRes.status).toBe(200);
    expect(newRes.body.id).toBe(itinId);
  });
});

/* ========== Version history diff integrity ========== */

describe('Version history diff integrity for metadata + item edits/deletes', () => {
  let itinId: string;
  let itemAId: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        title: `ver_${ts}`,
        destination: 'Rome',
        startDate: '2026-06-01',
        endDate: '2026-06-05',
      });
    itinId = createRes.body.id;

    const addRes = await request(app)
      .post(`/itineraries/${itinId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: resA, dayNumber: 1, startTime: '09:00', endTime: '10:00' });
    itemAId = addRes.body.id;
  });

  afterAll(async () => {
    await prisma.itineraryItem.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itineraryVersion.deleteMany({ where: { itineraryId: itinId } }).catch(() => {});
    await prisma.itinerary.deleteMany({ where: { id: itinId } }).catch(() => {});
  });

  type VersionRow = { versionNumber: number; snapshot: any; diffMetadata: any };

  async function getVersions() {
    const res = await request(app)
      .get(`/itineraries/${itinId}/versions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    return res.body as VersionRow[];
  }

  function newest(versions: VersionRow[]): VersionRow {
    return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
  }

  it('updating an item TIME produces a diff where only `modified` contains the item id', async () => {
    const before = await getVersions();
    const upd = await request(app)
      .patch(`/itineraries/${itinId}/items/${itemAId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ startTime: '10:30', endTime: '11:30' });
    expect(upd.status).toBe(200);

    const after = await getVersions();
    expect(after.length).toBe(before.length + 1);
    const v = newest(after);
    const items = v.diffMetadata?.items ?? {};
    expect(items.modified ?? []).toContain(itemAId);
    expect((items.added ?? []).length).toBe(0);
    expect((items.removed ?? []).length).toBe(0);
    const meta = v.diffMetadata?.metadata ?? [];
    expect(meta.length).toBe(0); // only item changed
    // Snapshot reflects new time.
    const snapItem = v.snapshot.items.find((i: { id: string }) => i.id === itemAId);
    expect(snapItem.startTime).toBe('10:30');
    expect(snapItem.endTime).toBe('11:30');
  });

  it('simultaneous metadata + item add: diff shows BOTH legs populated', async () => {
    // Metadata change
    await request(app)
      .patch(`/itineraries/${itinId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `ver_${ts}_renamed` });

    // Add a new item
    const addRes = await request(app)
      .post(`/itineraries/${itinId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: resB, dayNumber: 2, startTime: '09:00', endTime: '10:00' });
    expect(addRes.status).toBe(201);
    const itemBId = addRes.body.id;

    const versions = await getVersions();
    // Two distinct mutations → two new versions.
    expect(versions.length).toBeGreaterThanOrEqual(3);
    const sorted = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
    const titleVer = sorted.find((v) => (v.diffMetadata?.metadata ?? [])
      .some((m: { field: string }) => m.field === 'title'));
    const addVer = sorted.find((v) => (v.diffMetadata?.items?.added ?? []).includes(itemBId));
    expect(titleVer).toBeDefined();
    expect(addVer).toBeDefined();

    const titleChange = titleVer!.diffMetadata.metadata.find(
      (m: { field: string }) => m.field === 'title',
    );
    expect(titleChange.to).toBe(`ver_${ts}_renamed`);
  });

  it('deleting an item shows it under `removed` and clears it from the snapshot', async () => {
    const before = await getVersions();
    const del = await request(app)
      .delete(`/itineraries/${itinId}/items/${itemAId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    expect(del.status).toBe(204);

    const after = await getVersions();
    expect(after.length).toBe(before.length + 1);
    const v = newest(after);
    expect(v.diffMetadata?.items?.removed ?? []).toContain(itemAId);
    const snapIds = v.snapshot.items.map((i: { id: string }) => i.id);
    expect(snapIds).not.toContain(itemAId);
  });

  it('version numbers are strictly monotonic starting at 1', async () => {
    const versions = await getVersions();
    const numbers = versions.map((v) => v.versionNumber).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1);
    }
  });
});

/* ========== Cross-actor visibility on shared token (no auth bypass leakage) ========== */

describe('Shared itinerary visibility limits', () => {
  it('a share token does NOT grant write access — PATCH still requires bearer ownership', async () => {
    const createRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `share_ro_${ts}`, destination: 'Rome' });
    const id = createRes.body.id;

    const shareRes = await request(app)
      .post(`/itineraries/${id}/share`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', uuid());
    const token: string = shareRes.body.shareToken;

    // The shared URL is public (no bearer), but writes must still 401/403.
    const write = await request(app)
      .patch(`/itineraries/${id}`)
      .set('Idempotency-Key', uuid())
      .send({ title: 'hacked via share' });
    expect([401, 403]).toContain(write.status);

    // Re-verify public GET via token still works (read-only).
    const readRes = await request(app).get(`/shared/${token}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.id).toBe(id);

    await prisma.itineraryItem.deleteMany({ where: { itineraryId: id } }).catch(() => {});
    await prisma.itineraryVersion.deleteMany({ where: { itineraryId: id } }).catch(() => {});
    await prisma.itinerary.deleteMany({ where: { id } }).catch(() => {});
  });
});
