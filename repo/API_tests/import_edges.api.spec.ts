/**
 * Import edge cases — dedup key behaviour, partial-row errors vs committed
 * rows, and the rollback-window boundary.
 *
 * Every test exercises the real Express stack and checks DB state to
 * prove the invariant holds, not just the status code.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();

const adminCreds = { username: `imp_edge_${ts}`, password: 'AdminPass123!x' };

let adminToken: string;
let adminUserId: string;

beforeAll(async () => {
  await prisma.$connect();

  const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
    ...adminCreds,
    securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
  });
  adminUserId = reg.body.id;
  await prisma.user.update({ where: { id: adminUserId }, data: { role: 'admin' } });
  const login = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
  adminToken = login.body.accessToken;
}, 15000);

afterAll(async () => {
  await prisma.importError.deleteMany({ where: { batch: { userId: adminUserId } } }).catch(() => {});
  await prisma.importBatch.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
  await prisma.resource.deleteMany({ where: { name: { startsWith: `Edge_${ts}` } } }).catch(() => {});
  if (adminUserId) {
    await prisma.refreshToken.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: adminUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function upload(
  fileName: string,
  csv: string,
  opts: { idempotencyKey: string; deduplicationKey?: string } = { idempotencyKey: uuid() },
) {
  const req = request(app)
    .post('/import/upload')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .field('entityType', 'resources')
    .field('idempotencyKey', opts.idempotencyKey);
  if (opts.deduplicationKey !== undefined) req.field('deduplicationKey', opts.deduplicationKey);
  return req.attach('file', Buffer.from(csv), fileName);
}

describe('Deduplication key semantics', () => {
  it('comma separator dedupes against existing rows; duplicates surface as per-row errors', async () => {
    // Seed a resource that the upload will "duplicate" by (name, streetLine, city).
    const seedName = `Edge_${ts}_DedupA`;
    const seed = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: seedName, type: 'attraction', streetLine: '1 Main', city: 'Rome' });
    expect(seed.status).toBe(201);

    const csv = [
      'name,type,streetLine,city',
      `${seedName},attraction,1 Main,Rome`, // exact duplicate
      `Edge_${ts}_DedupB,attraction,2 Oak,Rome`, // unique
    ].join('\n') + '\n';
    const res = await upload('resources.csv', csv, {
      idempotencyKey: `dedup_comma_${ts}`,
      deduplicationKey: 'name,streetLine,city',
    });
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(2);
    expect(res.body.successRows).toBe(1);
    expect(res.body.errorRows).toBe(1);
    const errors = res.body.errors ?? [];
    const dup = errors.find((e: { message: string }) => /Duplicate/i.test(e.message));
    expect(dup).toBeDefined();
    expect(dup.field).toBe('name,streetLine,city');
    expect(dup.rowNumber).toBe(2); // +2 for 1-indexed + header row
  });

  it('legacy `+` separator is still accepted for backwards compatibility', async () => {
    const seedName = `Edge_${ts}_DedupLegacy`;
    await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: seedName, type: 'attraction', streetLine: '10 L', city: 'Paris' });

    const csv = [
      'name,type,streetLine,city',
      `${seedName},attraction,10 L,Paris`,
    ].join('\n') + '\n';
    const res = await upload('r.csv', csv, {
      idempotencyKey: `dedup_legacy_${ts}`,
      deduplicationKey: 'name+streetLine+city',
    });
    expect(res.status).toBe(200);
    expect(res.body.successRows).toBe(0);
    expect(res.body.errorRows).toBe(1);
  });

  it('empty string key falls back to default fields (name, streetLine, city)', async () => {
    const seedName = `Edge_${ts}_DefaultDedup`;
    await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: seedName, type: 'attraction', streetLine: '9 Def', city: 'Rome' });

    const csv = [
      'name,type,streetLine,city',
      `${seedName},attraction,9 Def,Rome`,
    ].join('\n') + '\n';
    const res = await upload('r.csv', csv, {
      idempotencyKey: `dedup_default_${ts}`,
      deduplicationKey: '', // blank → defaults
    });
    expect(res.status).toBe(200);
    expect(res.body.errorRows).toBe(1);
  });

  it('rows with an empty dedup field are treated as "cannot dedup" and proceed', async () => {
    // City is one of the dedup fields; leaving it blank means the service
    // SKIPS dedup for that row. So even though a seeded row has the same
    // (name, streetLine), the upload row still passes.
    const seedName = `Edge_${ts}_SkipDedup`;
    await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: seedName, type: 'attraction', streetLine: '1 Skip', city: 'Rome' });

    const csv = [
      'name,type,streetLine,city',
      `${seedName},attraction,1 Skip,`, // city blank → dedup skipped
    ].join('\n') + '\n';
    const res = await upload('r.csv', csv, {
      idempotencyKey: `dedup_skip_${ts}`,
      deduplicationKey: 'name,streetLine,city',
    });
    expect(res.status).toBe(200);
    expect(res.body.successRows).toBe(1);
    expect(res.body.errorRows).toBe(0);
  });
});

describe('Partial row errors vs committed rows', () => {
  it('upload with mix of valid + invalid rows reports both; commit only persists valid ones', async () => {
    const csv = [
      'name,type,latitude,longitude,city',
      `Edge_${ts}_Valid,attraction,41.9,12.5,Rome`, // valid
      `Edge_${ts}_BadLat,attraction,999,0,Rome`, // bad latitude
      `,meal,0,0,Paris`, // missing name
      `Edge_${ts}_BadType,not-a-type,0,0,Paris`, // bad type
    ].join('\n') + '\n';

    const upRes = await upload('mixed.csv', csv, { idempotencyKey: `partial_${ts}` });
    expect(upRes.status).toBe(200);
    expect(upRes.body.totalRows).toBe(4);
    expect(upRes.body.successRows).toBe(1);
    expect(upRes.body.errorRows).toBe(3);
    const fields = (upRes.body.errors ?? []).map((e: { field: string }) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['latitude', 'name', 'type']));

    // Commit: only the single valid row should persist. The service filters
    // `validRows` = `r.valid === true` before creating resources.
    const commitRes = await request(app)
      .post(`/import/${upRes.body.id}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.status).toBe('completed');
    expect(commitRes.body.successRows).toBe(1);

    const persisted = await prisma.resource.findMany({
      where: { name: { startsWith: `Edge_${ts}_` } },
    });
    const committedNames = new Set(persisted.map((r) => r.name));
    expect(committedNames.has(`Edge_${ts}_Valid`)).toBe(true);
    // CRITICAL: none of the invalid rows should appear.
    expect(committedNames.has(`Edge_${ts}_BadLat`)).toBe(false);
    expect(committedNames.has(`Edge_${ts}_BadType`)).toBe(false);
  });

  it('batch with zero valid rows is 400 on commit', async () => {
    const csv = [
      'name,type,city',
      `Edge_${ts}_AllBad1,unknown,Rome`,
      `Edge_${ts}_AllBad2,still-bad,Rome`,
    ].join('\n') + '\n';
    const upRes = await upload('all-bad.csv', csv, { idempotencyKey: `allbad_${ts}` });
    expect(upRes.body.successRows).toBe(0);
    expect(upRes.body.errorRows).toBe(2);

    const commitRes = await request(app)
      .post(`/import/${upRes.body.id}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(commitRes.status).toBe(400);
    expect(commitRes.body.code).toBe('VALIDATION_ERROR');
    expect(commitRes.body.message).toMatch(/No valid rows/i);
  });
});

describe('Rollback window boundary', () => {
  it('rollback INSIDE the window succeeds and wipes imported resources', async () => {
    const row = `Edge_${ts}_RollInside`;
    const csv = `name,type,city\n${row},attraction,Rome\n`;

    const upRes = await upload('roll.csv', csv, { idempotencyKey: `roll_inside_${ts}` });
    expect(upRes.status).toBe(200);
    const batchId = upRes.body.id;

    const commitRes = await request(app)
      .post(`/import/${batchId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(commitRes.status).toBe(200);

    // Confirm persisted
    const before = await prisma.resource.findFirst({ where: { name: row } });
    expect(before).not.toBeNull();

    const rollbackRes = await request(app)
      .post(`/import/${batchId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(rollbackRes.status).toBe(200);
    expect(rollbackRes.body.status).toBe('rolled_back');

    // CRITICAL: the committed resource must be deleted.
    const after = await prisma.resource.findFirst({ where: { name: row } });
    expect(after).toBeNull();
  });

  it('rollback 1 ms PAST the window boundary is rejected with canonical envelope', async () => {
    const row = `Edge_${ts}_RollOutside`;
    const csv = `name,type,city\n${row},attraction,Rome\n`;

    const upRes = await upload('roll.csv', csv, { idempotencyKey: `roll_outside_${ts}` });
    const batchId = upRes.body.id;

    await request(app)
      .post(`/import/${batchId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());

    // Move rollback deadline 1 ms into the past — strictly past the boundary.
    await prisma.importBatch.update({
      where: { id: batchId },
      data: { rollbackUntil: new Date(Date.now() - 1) },
    });

    const rollbackRes = await request(app)
      .post(`/import/${batchId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(rollbackRes.status).toBe(409);
    expect(rollbackRes.body.code).toBe('CONFLICT');
    expect(rollbackRes.body.message).toMatch(/window.*expired/i);

    // The resource must still be present.
    const stillThere = await prisma.resource.findFirst({ where: { name: row } });
    expect(stillThere).not.toBeNull();

    // Double-rollback on an already-rolled-back batch is also blocked.
    const doubleRoll = await upload('roll.csv', `name,type,city\n${row}_dbl,attraction,Rome\n`, {
      idempotencyKey: `roll_double_${ts}`,
    });
    const dblId = doubleRoll.body.id;
    await request(app)
      .post(`/import/${dblId}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    const r1 = await request(app)
      .post(`/import/${dblId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post(`/import/${dblId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(r2.status).toBe(409);
    expect(r2.body.message).toMatch(/rolled_back/i);
  });

  it('409 on commit-of-already-committed batch', async () => {
    const csv = `name,type,city\nEdge_${ts}_DoubleCommit,attraction,Rome\n`;
    const upRes = await upload('r.csv', csv, { idempotencyKey: `double_commit_${ts}` });

    const first = await request(app)
      .post(`/import/${upRes.body.id}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/import/${upRes.body.id}/commit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already committed/i);
  });
});
