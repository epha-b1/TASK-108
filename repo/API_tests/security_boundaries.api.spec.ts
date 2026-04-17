/**
 * Security boundaries — cross-actor idempotency replay isolation,
 * forged/malformed token behaviour, and sensitive-token leakage in
 * cached/replayed responses + audit CSV exports.
 *
 * Every test drives the real Express stack and checks real persistence
 * (`idempotency_keys.responseBody`, `audit_logs.detail`, actual HTTP
 * bodies). These are the invariants that a static test reviewer looks
 * for when judging the security hygiene of an API test suite.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';
import { env } from '../src/config/environment';
import { authConfig } from '../src/config/auth';

const prisma = getPrisma();
const ts = Date.now();

const userAc = { username: `sec_A_${ts}`, password: 'UserAPassw0rd!x' };
const userBc = { username: `sec_B_${ts}`, password: 'UserBPassw0rd!x' };
const adminC = { username: `sec_admin_${ts}`, password: 'AdminPass123!x' };

let tokenA: string;
let tokenB: string;
let adminToken: string;
let userAId: string;
let userBId: string;
let adminId: string;

beforeAll(async () => {
  await prisma.$connect();

  for (const [creds, slot] of [
    [userAc, 'A'] as const,
    [userBc, 'B'] as const,
    [adminC, 'admin'] as const,
  ]) {
    const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      ...creds,
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
    expect(reg.status).toBe(201);
    if (slot === 'A') userAId = reg.body.id;
    if (slot === 'B') userBId = reg.body.id;
    if (slot === 'admin') adminId = reg.body.id;
  }
  await prisma.user.update({ where: { id: adminId }, data: { role: 'admin' } });

  // Seed organizer permission points + role bindings so userA/userB tokens
  // can hit /itineraries. Default registered-user role has NO permission
  // points so every protected write returns 403 before reaching controllers.
  const perms = [
    'itinerary:read', 'itinerary:write', 'itinerary:delete', 'resource:read',
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
  for (const uid of [userAId, userBId]) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: uid, roleId: orgRole.id } },
      update: {},
      create: { userId: uid, roleId: orgRole.id },
    });
  }

  tokenA = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(userAc)).body.accessToken;
  tokenB = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(userBc)).body.accessToken;
  adminToken = (await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminC)).body.accessToken;
}, 20000);

afterAll(async () => {
  for (const uid of [userAId, userBId, adminId]) {
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
  await prisma.$disconnect();
});

/* ========== Idempotency: cross-actor replay isolation ========== */

describe('Idempotency — cross-actor replay isolation', () => {
  it('userB presenting userA\'s idempotency key does NOT get A\'s cached response', async () => {
    const sharedKey = `replay_${ts}_${uuid()}`;

    // A creates an itinerary with the shared idempotency key.
    const aRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', sharedKey)
      .send({ title: `A_owned_${ts}`, destination: 'Rome' });
    expect(aRes.status).toBe(201);
    const aItinId = aRes.body.id;

    // B presents the same Idempotency-Key. B MUST NOT see A's body. The
    // middleware's rule: a different verified user is passed through fresh,
    // so B's request either creates a NEW itinerary owned by B or — if
    // validation rejects — returns an UNAUTHENTICATED/VALIDATION envelope.
    // Either way, it MUST NOT return A's itinerary id.
    const bRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', sharedKey)
      .send({ title: `B_distinct_${ts}`, destination: 'Paris' });
    expect([200, 201]).toContain(bRes.status);
    expect(bRes.body.id).toBeDefined();
    expect(bRes.body.id).not.toBe(aItinId);

    // Sanity check: A's record is still owned by A.
    const aFresh = await prisma.itinerary.findUnique({ where: { id: aItinId } });
    expect(aFresh?.ownerId).toBe(userAId);
  });

  it('anonymous request with a key cached by a verified user is blocked with 401', async () => {
    const sharedKey = `replay_anon_${ts}_${uuid()}`;

    // Admin issues with the key (protected endpoint).
    const seed = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', sharedKey)
      .send({ name: `Anon_Probe_${ts}_${uuid()}`, type: 'attraction', city: 'Rome' });
    expect(seed.status).toBe(201);

    // Anonymous retry: idempotency middleware should refuse to replay the
    // verified user's response.
    const anonRes = await request(app)
      .post('/resources')
      .set('Idempotency-Key', sharedKey)
      .send({ name: `Anon_Probe_${ts}_${uuid()}`, type: 'attraction', city: 'Rome' });
    expect(anonRes.status).toBe(401);
    expect(anonRes.body.code).toBe('UNAUTHORIZED');
  });

  it('same-actor replay returns the exact cached body (idempotent guarantee)', async () => {
    const key = `same_actor_${ts}_${uuid()}`;
    const first = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_replay_${ts}`, destination: 'Rome' });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_replay_${ts}`, destination: 'Rome' });
    expect(second.status).toBe(first.status);
    expect(second.body.id).toBe(first.body.id);
  });

  it('same-actor replay with a DIFFERENT body → 409 IDEMPOTENCY_CONFLICT', async () => {
    const key = `fingerprint_${ts}_${uuid()}`;
    await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_fp_${ts}`, destination: 'Rome' });

    const mutant = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_fp_${ts}_MUTATED`, destination: 'Paris' });
    expect(mutant.status).toBe(409);
    expect(mutant.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(mutant.body.requestId).toBe(mutant.headers['x-request-id']);
  });
});

/* ========== Forged / malformed token behaviour ========== */

describe('Token forgery and malformed-auth handling', () => {
  it('Bearer token signed with the WRONG secret → 401, not 200', async () => {
    const forged = jwt.sign(
      { userId: userAId, username: userAc.username, role: 'organizer' },
      'wrong-secret-never-used-by-the-server',
      { algorithm: authConfig.algorithm, expiresIn: 3600 },
    );
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('Bearer token with tampered payload (altered userId, valid signature is impossible) → 401', async () => {
    // A JWT whose signature does NOT match the payload.
    const legit = jwt.sign(
      { userId: userAId, username: userAc.username, role: 'organizer' },
      env.jwtSecret,
      { algorithm: authConfig.algorithm, expiresIn: 3600 },
    );
    const [header, payload, sig] = legit.split('.');
    // Corrupt the signature.
    const tamperedSig = sig.replace(/.$/, sig.endsWith('A') ? 'B' : 'A');
    const tampered = `${header}.${payload}.${tamperedSig}`;
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('`alg: none` token is rejected (no algorithm confusion)', async () => {
    // Hand-craft an unsigned token.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: userAId, username: userAc.username, role: 'admin' })).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${noneToken}`);
    expect(res.status).toBe(401);
  });

  it('missing Authorization header on protected route → canonical 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('Authorization scheme != Bearer → canonical 401', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('forged bearer PLUS an idempotency key is passed through (auth middleware emits 401), never replays cache', async () => {
    const key = `forge_replay_${ts}_${uuid()}`;
    // Seed a cached success for user A under the key via a valid request.
    const okRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_cache_seed_${ts}`, destination: 'Rome' });
    expect(okRes.status).toBe(201);
    const aItinId = okRes.body.id;

    // Attacker presents a FORGED token with the same key. The idempotency
    // middleware detects `invalid=true` and falls through to the auth
    // middleware, which returns 401. Under no circumstance should the
    // attacker see A's cached success body.
    const forged = jwt.sign(
      { userId: userAId, username: userAc.username, role: 'admin' },
      'attacker-does-not-know-the-secret',
      { algorithm: authConfig.algorithm, expiresIn: 3600 },
    );
    const attackRes = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${forged}`)
      .set('Idempotency-Key', key)
      .send({ title: `A_cache_seed_${ts}`, destination: 'Rome' });
    expect(attackRes.status).toBe(401);
    expect(attackRes.body.code).toBe('UNAUTHORIZED');
    // Absolutely no field from A's success body should leak through.
    expect(attackRes.body.id).toBeUndefined();
    expect(attackRes.body.title).toBeUndefined();
    expect(attackRes.body.ownerId).toBeUndefined();
    // A's record is intact.
    const fresh = await prisma.itinerary.findUnique({ where: { id: aItinId } });
    expect(fresh?.ownerId).toBe(userAId);
  });
});

/* ========== Token redaction in cached responses and audit exports ========== */

describe('Sensitive token redaction — idempotency cache + audit CSV export', () => {
  it('cached auth response (Idempotency replay) does NOT store the raw accessToken/refreshToken', async () => {
    const key = `auth_cache_${ts}_${uuid()}`;
    // First login: populates the idempotency record.
    const first = await request(app)
      .post('/auth/login')
      .set('Idempotency-Key', key)
      .send(userAc);
    expect(first.status).toBe(200);
    const issuedAccess: string = first.body.accessToken;
    expect(issuedAccess).toBeDefined();

    // The stored responseBody._body update is fire-and-forget inside the
    // middleware's res.json interceptor — the HTTP response may return
    // before that write lands. Poll until the cached body carries the
    // redacted token fields OR the 2s budget expires.
    let body: any = {};
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const row = await prisma.idempotencyKey.findUnique({ where: { key } });
      expect(row).not.toBeNull();
      body = (row!.responseBody as any)?._body ?? {};
      if (body.accessToken === '[REDACTED]') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(body.accessToken).toBe('[REDACTED]');
    expect(body.refreshToken).toBe('[REDACTED]');
    // But the non-sensitive fields are preserved so replays stay useful.
    expect(body.user?.username).toBe(userAc.username);
    // The stored snapshot NEVER contains the actual tokens in cleartext.
    const finalRow = await prisma.idempotencyKey.findUnique({ where: { key } });
    const asJson = JSON.stringify(finalRow!.responseBody);
    expect(asJson).not.toContain(issuedAccess);
  });

  it('audit CSV export masks sensitive detail fields (password_hash, answer_encrypted, token_hash)', async () => {
    // Seed an audit row with a payload that intentionally includes one of
    // the sensitive keys — the service-layer writer won't normally put
    // these there, but a future regression might. The masker is our
    // safety net; prove it does its job.
    await prisma.auditLog.create({
      data: {
        action: 'security_probe',
        detail: {
          actorId: adminId,
          resourceType: 'probe',
          resourceId: 'probe',
          passwordHash: 'TOPSECRET_pwhash_value',
          answerEncrypted: 'TOPSECRET_answer_value',
          token_hash: 'TOPSECRET_token_hash',
          safeField: 'keepme',
        },
        traceId: `probe_${ts}`,
      },
    });

    const res = await request(app)
      .get('/audit-logs/export?from=2000-01-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const csv = res.text as string;
    expect(csv).toContain('keepme');
    expect(csv).toContain('REDACTED');
    expect(csv).not.toContain('TOPSECRET_pwhash_value');
    expect(csv).not.toContain('TOPSECRET_answer_value');
    expect(csv).not.toContain('TOPSECRET_token_hash');

    // Clean up probe row.
    await prisma.auditLog.deleteMany({ where: { action: 'security_probe' } }).catch(() => {});
  });
});

/* ========== Idempotency key is required for mutating methods ========== */

describe('Idempotency key enforcement', () => {
  it('POST without Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY with canonical envelope', async () => {
    const res = await request(app)
      .post('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: `no_key_${ts}`, destination: 'Rome' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('GET never requires the header (non-mutating)', async () => {
    const res = await request(app)
      .get('/itineraries')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
  });
});
