import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `itin_admin_${ts}`, password: 'AdminPass123!x' };
const orgACreds = { username: `itin_orgA_${ts}`, password: 'OrgPass12345!x' };
const orgBCreds = { username: `itin_orgB_${ts}`, password: 'OrgPass12345!y' };

let adminToken: string;
let orgAToken: string;
let orgBToken: string;
let adminUserId: string;
let orgAUserId: string;
let orgBUserId: string;

let resourceId: string;
let resourceId2: string;
let itineraryId: string;
let itemId: string;
let shareToken: string;

beforeAll(async () => {
  await prisma.$connect();

  // Register admin
  const adminReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  adminUserId = adminReg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const adminLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = adminLogin.body.accessToken;

  // Register organizer A
  const orgAReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...orgACreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  orgAUserId = orgAReg.body.id;
  const orgALogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgACreds);
  orgAToken = orgALogin.body.accessToken;

  // Register organizer B
  const orgBReg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...orgBCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  orgBUserId = orgBReg.body.id;
  const orgBLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgBCreds);
  orgBToken = orgBLogin.body.accessToken;

  // Set up RBAC permissions for organizers
  const orgPerms = ['itinerary:read', 'itinerary:write', 'itinerary:delete', 'resource:read'];
  const ppIds: string[] = [];
  for (const code of orgPerms) {
    const pp = await prisma.permissionPoint.upsert({
      where: { code },
      update: {},
      create: { code },
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
  for (const uid of [orgAUserId, orgBUserId]) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: uid, roleId: orgRole.id } },
      update: {},
      create: { userId: uid, roleId: orgRole.id },
    });
  }

  // Create resources
  const res1 = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `Itin Res1 ${ts}`, type: 'attraction', city: 'TestCity', region: 'TestRegion', minDwellMinutes: 30 });
  resourceId = res1.body.id;

  const res2 = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `Itin Res2 ${ts}`, type: 'attraction', city: 'TestCity', region: 'TestRegion', minDwellMinutes: 60 });
  resourceId2 = res2.body.id;
}, 15000);

afterAll(async () => {
  for (const uid of [adminUserId, orgAUserId, orgBUserId]) {
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
  for (const rid of [resourceId, resourceId2]) {
    if (!rid) continue;
    await prisma.travelTimeMatrix.deleteMany({ where: { OR: [{ fromResourceId: rid }, { toResourceId: rid }] } }).catch(() => {});
    await prisma.resourceClosure.deleteMany({ where: { resourceId: rid } }).catch(() => {});
    await prisma.resourceHour.deleteMany({ where: { resourceId: rid } }).catch(() => {});
    await prisma.resource.deleteMany({ where: { id: rid } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe('POST /itineraries', () => {
  it('201 — creates itinerary', async () => {
    const res = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `Test Trip ${ts}`, destination: 'TestCity', startDate: '2026-06-01', endDate: '2026-06-05' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    itineraryId = res.body.id;
  });
});

describe('GET /itineraries', () => {
  it('200 — organizer sees only own itineraries', async () => {
    const res = await request(app).get('/itineraries').set('Authorization', `Bearer ${orgAToken}`);
    expect(res.status).toBe(200);
    for (const it of res.body.data) {
      expect(it.ownerId).toBe(orgAUserId);
    }
  });
});

describe('POST /itineraries/:id/items', () => {
  it('201 — adds item', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00', notes: 'Morning visit' });
    expect(res.status).toBe(201);
    itemId = res.body.id;
  });

  it('409 — overlap conflict', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: resourceId2, dayNumber: 1, startTime: '09:30', endTime: '10:30' });
    expect(res.status).toBe(409);
  });

  it('400 — dwell time violation', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId: resourceId2, dayNumber: 1, startTime: '14:00', endTime: '14:10' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/dwell|Duration/i);
  });
});

describe('GET /itineraries/:id/versions', () => {
  it('200 — has versions', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

// === Versioning semantics ===
// Business rules under test:
//   1. POST /itineraries creates a version 1 snapshot at creation time.
//   2. PATCH /itineraries/:id with ONLY status change does NOT create a new version.
//   3. PATCH /itineraries/:id that mutates content fields (title/destination/dates)
//      DOES create a new version.
describe('Itinerary versioning semantics', () => {
  let verItinId: string;

  afterAll(async () => {
    if (verItinId) {
      await prisma.itineraryItem.deleteMany({ where: { itineraryId: verItinId } }).catch(() => {});
      await prisma.itineraryVersion.deleteMany({ where: { itineraryId: verItinId } }).catch(() => {});
      await prisma.itinerary.deleteMany({ where: { id: verItinId } }).catch(() => {});
    }
  });

  it('initial create — produces version 1 with metadata + empty items', async () => {
    const createRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        title: `Versioning Trip ${ts}_${uuid()}`,
        destination: 'VerCity',
        startDate: '2026-07-01',
        endDate: '2026-07-05',
      });
    expect(createRes.status).toBe(201);
    verItinId = createRes.body.id;

    const versionsRes = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(versionsRes.status).toBe(200);
    expect(Array.isArray(versionsRes.body)).toBe(true);
    expect(versionsRes.body.length).toBe(1);
    expect(versionsRes.body[0].versionNumber).toBe(1);
    // Snapshot now captures BOTH itinerary metadata and the items list at
    // creation time (was items-only before the version-fidelity fix).
    const snap = versionsRes.body[0].snapshot;
    expect(snap).toBeDefined();
    expect(snap.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(snap.metadata).toBeDefined();
    expect(snap.metadata.id).toBe(verItinId);
    expect(snap.metadata.destination).toBe('VerCity');
    expect(snap.metadata.title).toMatch(/Versioning Trip/);
    expect(Array.isArray(snap.items)).toBe(true);
    expect(snap.items.length).toBe(0);
  });


  it('PATCH status only — does NOT create a new version', async () => {
    const before = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    const beforeCount = before.body.length;

    const patchRes = await request(app)
      .patch(`/itineraries/${verItinId}`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ status: 'published' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('published');

    const after = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(after.status).toBe(200);
    expect(after.body.length).toBe(beforeCount);
    // Highest versionNumber unchanged.
    const maxBefore = Math.max(...before.body.map((v: { versionNumber: number }) => v.versionNumber));
    const maxAfter = Math.max(...after.body.map((v: { versionNumber: number }) => v.versionNumber));
    expect(maxAfter).toBe(maxBefore);
  });

  it('PATCH content (title) — creates a version with metadata diff', async () => {
    const before = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    const beforeCount = before.body.length;
    const beforeMax = Math.max(...before.body.map((v: { versionNumber: number }) => v.versionNumber));

    const patchRes = await request(app)
      .patch(`/itineraries/${verItinId}`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ title: `Versioning Trip Renamed ${ts}` });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.title).toBe(`Versioning Trip Renamed ${ts}`);

    const after = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(after.status).toBe(200);
    expect(after.body.length).toBe(beforeCount + 1);
    const sorted = [...after.body].sort(
      (a: { versionNumber: number }, b: { versionNumber: number }) => b.versionNumber - a.versionNumber,
    );
    const newest = sorted[0];
    expect(newest.versionNumber).toBe(beforeMax + 1);
    // Snapshot reflects the new title.
    expect(newest.snapshot.metadata.title).toBe(`Versioning Trip Renamed ${ts}`);
    // Diff metadata should contain a `title` change entry under metadata.
    const metaChanges = newest.diffMetadata?.metadata ?? [];
    const titleChange = metaChanges.find((c: { field: string }) => c.field === 'title');
    expect(titleChange).toBeDefined();
    expect(titleChange.to).toBe(`Versioning Trip Renamed ${ts}`);
    // Items list unchanged for this PATCH.
    expect(newest.diffMetadata?.items?.added?.length ?? 0).toBe(0);
    expect(newest.diffMetadata?.items?.removed?.length ?? 0).toBe(0);
    expect(newest.diffMetadata?.items?.modified?.length ?? 0).toBe(0);
  });

  it('PATCH content (destination) — diff includes destination change', async () => {
    const before = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    const beforeCount = before.body.length;

    const patchRes = await request(app)
      .patch(`/itineraries/${verItinId}`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ destination: 'NewDestinationCity' });
    expect(patchRes.status).toBe(200);

    const after = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(after.body.length).toBe(beforeCount + 1);
    const newest = [...after.body].sort(
      (a: { versionNumber: number }, b: { versionNumber: number }) => b.versionNumber - a.versionNumber,
    )[0];
    expect(newest.snapshot.metadata.destination).toBe('NewDestinationCity');
    const destChange = (newest.diffMetadata?.metadata ?? []).find(
      (c: { field: string }) => c.field === 'destination',
    );
    expect(destChange).toBeDefined();
    expect(destChange.to).toBe('NewDestinationCity');
  });

  it('Add itinerary item — version diff lists the added item', async () => {
    const itemRes = await request(app)
      .post(`/itineraries/${verItinId}/items`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00' });
    expect(itemRes.status).toBe(201);
    const newItemId = itemRes.body.id;

    const versions = await request(app)
      .get(`/itineraries/${verItinId}/versions`)
      .set('Authorization', `Bearer ${orgAToken}`);
    const newest = [...versions.body].sort(
      (a: { versionNumber: number }, b: { versionNumber: number }) => b.versionNumber - a.versionNumber,
    )[0];
    expect(newest.snapshot.items.length).toBe(1);
    expect(newest.snapshot.items[0].id).toBe(newItemId);
    expect(newest.diffMetadata?.items?.added).toContain(newItemId);
  });
});

describe('GET /itineraries/:id/optimize', () => {
  it('200 — returns suggestions', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/optimize`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /itineraries/:id/share', () => {
  it('200 — owner can share', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/share`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    expect(res.body.shareToken).toBeDefined();
    shareToken = res.body.shareToken;
  });
});

describe('GET /shared/:token', () => {
  it('200 — public access works', async () => {
    const res = await request(app).get(`/shared/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(itineraryId);
  });
});

describe('GET /itineraries/:id/export', () => {
  it('200 — owner can export', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/export`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe('1.0');
    expect(res.body.itinerary.id).toBe(itineraryId);
  });
});

describe('Cross-user authorization', () => {
  it('403 — orgB cannot share orgA itinerary', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/share`)
      .set('Authorization', `Bearer ${orgBToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(403);
  });

  it('403 — orgB cannot export orgA itinerary', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}/export`)
      .set('Authorization', `Bearer ${orgBToken}`);
    expect(res.status).toBe(403);
  });

  it('403 — orgB cannot get orgA itinerary', async () => {
    const res = await request(app)
      .get(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${orgBToken}`);
    expect(res.status).toBe(403);
  });

  it('403 — orgB cannot add items to orgA itinerary', async () => {
    const res = await request(app)
      .post(`/itineraries/${itineraryId}/items`)
      .set('Authorization', `Bearer ${orgBToken}`)
      .set('Idempotency-Key', uuid())
      .send({ resourceId, dayNumber: 2, startTime: '10:00', endTime: '11:00' });
    expect(res.status).toBe(403);
  });

  it('200 — orgB sees empty list (no own itineraries)', async () => {
    const res = await request(app).get('/itineraries').set('Authorization', `Bearer ${orgBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(0);
  });
});

describe('DELETE /itineraries/:id', () => {
  it('204 — deletes itinerary', async () => {
    const res = await request(app)
      .delete(`/itineraries/${itineraryId}`)
      .set('Authorization', `Bearer ${orgAToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(204);
    itineraryId = '';
  });
});
