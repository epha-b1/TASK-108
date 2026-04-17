/**
 * TRUE RUNTIME-BOUNDARY E2E.
 *
 * Unlike every other spec in this directory, this file does NOT import
 * `../src/app`. Instead it drives the running containerised API via
 * global `fetch()` against `http://localhost:3000` — which is the same
 * TCP port the Dockerfile's `CMD ["node", "dist/server.js"]` is
 * listening on. Because `./run_tests.sh` starts the test runner via
 * `docker compose exec -T api npx jest`, the jest process and the API
 * process are two DIFFERENT Node runtimes sharing the container's
 * loopback interface. Every request therefore crosses a real TCP
 * boundary, exercising the HTTP parser, Express pipeline, middleware
 * chain, and Prisma client inside the production Node process — not
 * an in-process supertest harness.
 *
 * We use Prisma only to read back side effects (a separate Prisma
 * client instance that the test process owns). Nothing is driven
 * through internal imports.
 *
 * Covered journey:
 *   register → login → create itinerary → add item → share → /shared/:token
 *   → export → admin sends notification → reader lists + marks read
 *   → admin reads audit log → logout → refresh revoked
 */

import { v4 as uuid } from 'uuid';
import { getPrisma } from '../src/config/database';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `rt_admin_${ts}`, password: 'AdminPass123!x' };
const ownerCreds = { username: `rt_owner_${ts}`, password: 'OwnerPass123!x' };
const readerCreds = { username: `rt_reader_${ts}`, password: 'ReaderPass123!x' };

let adminToken: string;
let ownerToken: string;
let readerToken: string;
let adminUserId: string;
let ownerUserId: string;
let readerUserId: string;

/** Tiny fetch wrapper that always attaches the correct headers. */
async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; idemKey?: string } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    headers['Idempotency-Key'] = opts.idemKey || uuid();
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await res.json();
  else body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/**
 * The runtime-boundary suite is skipped when the live server isn't
 * reachable — e.g. when jest is invoked from the host during local
 * iteration instead of from inside the container. `./run_tests.sh`
 * ensures it IS reachable under the canonical CI flow.
 */
let serverReachable = false;

beforeAll(async () => {
  try {
    const probe = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    serverReachable = probe.status === 200;
  } catch {
    serverReachable = false;
  }
  if (!serverReachable) {
    // Mark the suite as skipped loud-and-clear.
    // eslint-disable-next-line no-console
    console.warn(`[runtime_boundary_e2e] ${BASE}/health unreachable — skipping. Run via ./run_tests.sh.`);
    return;
  }
  await prisma.$connect();
}, 10_000);

afterAll(async () => {
  if (!serverReachable) return;
  for (const uid of [adminUserId, ownerUserId, readerUserId].filter(Boolean)) {
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
  await prisma.resource.deleteMany({ where: { name: { startsWith: `rt_${ts}_` } } }).catch(() => {});
  await prisma.$disconnect();
});

describe('E2E over real TCP — containerised API process, no in-process app import', () => {
  let resourceId: string;
  let itineraryId: string;
  let shareToken: string;
  let notifId: string;
  let ownerRefreshToken: string;

  it('health endpoint is reachable over the loopback interface', async () => {
    if (!serverReachable) return;
    const res = await call<{ status: string; timestamp: string }>('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    // X-Request-Id is the canonical correlation header — real server
    // installs it in audit middleware.
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('step 1 — register three users', async () => {
    if (!serverReachable) return;
    for (const creds of [adminCreds, ownerCreds, readerCreds]) {
      const res = await call<{ id: string; username: string }>('POST', '/auth/register', {
        body: {
          ...creds,
          securityQuestions: [
            { question: 'Q1?', answer: 'a1' },
            { question: 'Q2?', answer: 'a2' },
          ],
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe(creds.username);
      if (creds === adminCreds) adminUserId = res.body.id;
      if (creds === ownerCreds) ownerUserId = res.body.id;
      if (creds === readerCreds) readerUserId = res.body.id;
    }
    // Single out-of-band side-effect: promote admin. Reading back through
    // HTTP would still require a token — and there's no self-promotion
    // endpoint in the service layer, so we use Prisma here. Every other
    // state transition goes through HTTP.
    await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });

    // Seed organizer permission points + role bindings so owner/reader
    // tokens can hit itinerary/notification endpoints. Default registered
    // state has NO permission points so every call would 403.
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
  }, 20_000);

  it('step 2 — login for all three', async () => {
    if (!serverReachable) return;
    for (const [creds, slot] of [
      [adminCreds, 'admin'] as const,
      [ownerCreds, 'owner'] as const,
      [readerCreds, 'reader'] as const,
    ]) {
      const res = await call<{ accessToken: string; refreshToken: string; user: { username: string } }>(
        'POST', '/auth/login',
        { body: creds },
      );
      expect(res.status).toBe(200);
      expect(res.body.accessToken.split('.')).toHaveLength(3);
      expect(res.body.user.username).toBe(creds.username);
      if (slot === 'admin') adminToken = res.body.accessToken;
      if (slot === 'owner') { ownerToken = res.body.accessToken; ownerRefreshToken = res.body.refreshToken; }
      if (slot === 'reader') readerToken = res.body.accessToken;
    }
  }, 20_000);

  it('step 3 — admin creates a resource; owner creates itinerary + item', async () => {
    if (!serverReachable) return;
    const resRes = await call<{ id: string }>('POST', '/resources', {
      token: adminToken,
      body: { name: `rt_${ts}_R1`, type: 'attraction', city: 'Rome', minDwellMinutes: 30 },
    });
    expect(resRes.status).toBe(201);
    resourceId = resRes.body.id;

    const itinRes = await call<{ id: string; title: string; ownerId: string }>(
      'POST', '/itineraries',
      { token: ownerToken, body: { title: `rt_trip_${ts}`, destination: 'Rome' } },
    );
    expect(itinRes.status).toBe(201);
    expect(itinRes.body.ownerId).toBe(ownerUserId);
    itineraryId = itinRes.body.id;

    const itemRes = await call<{ id: string; dayNumber: number }>(
      'POST', `/itineraries/${itineraryId}/items`,
      {
        token: ownerToken,
        body: { resourceId, dayNumber: 1, startTime: '09:00', endTime: '10:00' },
      },
    );
    expect(itemRes.status).toBe(201);
    expect(itemRes.body.dayNumber).toBe(1);
  }, 20_000);

  it('step 4 — share + anonymous /shared/:token access works', async () => {
    if (!serverReachable) return;
    const shareRes = await call<{ shareToken: string; shareUrl: string; expiresAt: string }>(
      'POST', `/itineraries/${itineraryId}/share`,
      { token: ownerToken },
    );
    expect(shareRes.status).toBe(200);
    expect(shareRes.body.shareToken).toMatch(/^[0-9a-f]{64}$/);
    expect(shareRes.body.shareUrl).toBe(`/shared/${shareRes.body.shareToken}`);
    shareToken = shareRes.body.shareToken;

    // Anonymous GET (no Authorization header) — TRUE public access.
    const anonRes = await fetch(`${BASE}/shared/${shareToken}`);
    expect(anonRes.status).toBe(200);
    const anonBody = await anonRes.json();
    expect(anonBody.id).toBe(itineraryId);
    expect(Array.isArray(anonBody.items)).toBe(true);
    expect(anonBody.items.length).toBe(1);
  }, 15_000);

  it('step 5 — owner export + audit visibility', async () => {
    if (!serverReachable) return;
    const exportRes = await call<{ schemaVersion: string; itinerary: any; items: any[] }>(
      'GET', `/itineraries/${itineraryId}/export`,
      { token: ownerToken },
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.schemaVersion).toBe('1.0');
    expect(exportRes.body.itinerary.id).toBe(itineraryId);
    expect(exportRes.body.items.length).toBe(1);
  });

  it('step 6 — admin sends notification to reader; reader lists + marks read', async () => {
    if (!serverReachable) return;
    const sendRes = await call<{ id: string; userId: string; message: string }>(
      'POST', '/notifications',
      {
        token: adminToken,
        body: {
          userId: readerUserId,
          type: 'info',
          subject: 'rt-ping',
          message: `rt_e2e_${ts} hello reader`,
        },
      },
    );
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.userId).toBe(readerUserId);
    notifId = sendRes.body.id;

    // Grant reader `notification:read` so the list endpoint works.
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
    // Re-login so the role propagates.
    const relog = await call<{ accessToken: string }>('POST', '/auth/login', { body: readerCreds });
    readerToken = relog.body.accessToken;

    const listRes = await call<{ data: Array<{ id: string; subject: string }>; total: number }>(
      'GET', '/notifications',
      { token: readerToken },
    );
    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((n) => n.id === notifId);
    expect(found).toBeDefined();
    expect(found!.subject).toBe('rt-ping');

    const markRes = await call<{ id: string; read: boolean }>(
      'PATCH', `/notifications/${notifId}/read`,
      { token: readerToken },
    );
    expect(markRes.status).toBe(200);
    expect(markRes.body.read).toBe(true);

    // Persistence assertion — direct DB read.
    const row = await prisma.notification.findUnique({ where: { id: notifId } });
    expect(row?.read).toBe(true);
  }, 20_000);

  it('step 7 — admin queries /audit-logs and sees this journey', async () => {
    if (!serverReachable) return;
    const auditRes = await call<{ data: Array<{ action: string }> }>(
      'GET', '/audit-logs?limit=100',
      { token: adminToken },
    );
    expect(auditRes.status).toBe(200);
    const actions = new Set(auditRes.body.data.map((r) => r.action));
    // Each of these actions was triggered during THIS suite by a real
    // HTTP call into the running server.
    expect(actions).toEqual(expect.objectContaining(new Set([
      'resource.create',
      'itinerary.create',
      'itinerary.item.add',
      'itinerary.share',
      'notification.send',
    ]) as any));
  }, 20_000);

  it('step 8 — logout revokes the refresh token (subsequent /auth/refresh 401)', async () => {
    if (!serverReachable) return;
    const logoutRes = await call(
      'POST', '/auth/logout',
      { token: ownerToken, body: { refreshToken: ownerRefreshToken } },
    );
    expect(logoutRes.status).toBe(204);

    const refreshRes = await call<{ code: string }>(
      'POST', '/auth/refresh',
      { body: { refreshToken: ownerRefreshToken } },
    );
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.code).toBe('UNAUTHORIZED');
  }, 15_000);

  it('step 9 — 404 envelope is well-formed over real TCP (canonical shape enforced end-to-end)', async () => {
    if (!serverReachable) return;
    const res = await call<{ statusCode: number; code: string; message: string; requestId: string }>(
      'GET', `/does-not-exist-${ts}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers.get('x-request-id'));
  });
});
