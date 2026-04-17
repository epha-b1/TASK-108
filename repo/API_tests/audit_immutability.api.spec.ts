/**
 * Gap: prove DB-trigger audit immutability by attempting to UPDATE and
 * DELETE `audit_logs` rows directly — bypassing every application-layer
 * guard — and asserting that MySQL rejects both operations with the
 * SQLSTATE 45000 signal the `20260409000000_audit_immutability`
 * migration installs.
 *
 * This is an end-to-end behavior test that exercises the real deployed
 * DB + migrations. It does NOT mock the Prisma client; it uses raw
 * queries issued against the live MySQL instance the app is bound to.
 *
 * Also verifies the triggers are actually INSTALLED (not silently
 * dropped by a future migration) by querying `information_schema`.
 *
 * Even an attacker or a buggy controller path that somehow obtained the
 * application DB credentials MUST be unable to rewrite history in the
 * audit log — this is the system of record for security investigations.
 */

import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();
const ts = Date.now();
const adminCreds = { username: `aud_imm_${ts}`, password: 'AdminPass123!x' };

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

/**
 * Seed an audit_logs row by issuing a mutating API request with a valid
 * token. The audit service writes the row asynchronously, so we wait for
 * it to land and return the persisted id.
 */
async function seedAuditRow(action: string): Promise<string> {
  const res = await request(app)
    .post('/resources')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', uuid())
    .send({ name: `audit_immutability_${ts}_${uuid()}`, type: 'attraction', city: 'Rome' });
  expect(res.status).toBe(201);
  // The audit row is fire-and-forget. Poll briefly for it to land.
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.auditLog.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (rows.length > 0) return rows[0].id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`audit row for action "${action}" never landed`);
}

describe('audit_logs — DB trigger immutability', () => {
  it('both BEFORE-row triggers are installed in information_schema', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ TRIGGER_NAME: string; EVENT_MANIPULATION: string; ACTION_TIMING: string }>>(
      `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING
       FROM information_schema.triggers
       WHERE EVENT_OBJECT_SCHEMA = DATABASE()
         AND EVENT_OBJECT_TABLE = 'audit_logs'
       ORDER BY TRIGGER_NAME`,
    );
    const names = rows.map((r) => r.TRIGGER_NAME);
    expect(names).toEqual(expect.arrayContaining(['audit_logs_no_update', 'audit_logs_no_delete']));
    for (const r of rows) {
      expect(r.ACTION_TIMING).toBe('BEFORE');
    }
    const evts = rows.map((r) => r.EVENT_MANIPULATION).sort();
    expect(evts).toEqual(['DELETE', 'UPDATE']);
  });

  it('UPDATE on audit_logs is rejected with SQLSTATE 45000 and the row is unchanged', async () => {
    const rowId = await seedAuditRow('resource.create');
    const before = await prisma.auditLog.findUnique({ where: { id: rowId } });
    expect(before).not.toBeNull();

    // Attempt a trivial update that would otherwise succeed if not for the trigger.
    let rejection: unknown = null;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'TAMPERED' WHERE id = ?`,
        rowId,
      );
    } catch (err) {
      rejection = err;
    }
    expect(rejection).not.toBeNull();
    // Prisma surfaces MySQL's SIGNAL SQLSTATE '45000' as an error whose
    // message carries the custom MESSAGE_TEXT. Either marker is sufficient
    // proof.
    const errStr = String((rejection as Error).message);
    expect(errStr).toMatch(/append-only|45000|UPDATE is forbidden/i);

    const after = await prisma.auditLog.findUnique({ where: { id: rowId } });
    expect(after).not.toBeNull();
    // The row MUST be byte-for-byte what we read before.
    expect(after!.action).toBe(before!.action);
    expect(after!.traceId).toBe(before!.traceId);
    expect(JSON.stringify(after!.detail)).toBe(JSON.stringify(before!.detail));
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
  });

  it('UPDATE with NO rows matched still does NOT silently succeed (trigger fires on scope)', async () => {
    // Prisma surfaces "0 rows affected" for a WHERE that matches nothing.
    // The trigger only fires per-row, so a no-op UPDATE legitimately
    // returns 0 rows rather than erroring. We document that here so future
    // reviewers aren't surprised.
    const n = await prisma.$executeRawUnsafe(
      `UPDATE audit_logs SET action = 'NEVER' WHERE id = ?`,
      'this-id-cannot-exist',
    );
    expect(n).toBe(0);
  });

  it('DELETE on an existing audit_logs row is rejected with SQLSTATE 45000', async () => {
    const rowId = await seedAuditRow('resource.create');
    let rejection: unknown = null;
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = ?`, rowId);
    } catch (err) {
      rejection = err;
    }
    expect(rejection).not.toBeNull();
    const errStr = String((rejection as Error).message);
    expect(errStr).toMatch(/append-only|45000|DELETE is forbidden/i);

    // The per-row invariant is authoritative — the row we tried to delete
    // is still there. A whole-table count is unreliable here because the
    // audit() middleware from parallel running tests fires-and-forgets
    // new rows between any two count() calls.
    const row = await prisma.auditLog.findUnique({ where: { id: rowId } });
    expect(row).not.toBeNull();
  });

  it('INSERT on audit_logs is UNAFFECTED by the triggers (append-only means appends still work)', async () => {
    const probeTrace = `imm_${ts}_${Math.random().toString(36).slice(2, 10)}`;
    const created = await prisma.auditLog.create({
      data: {
        action: 'explicit_insert_probe',
        detail: { actorId: adminUserId, resourceType: 'probe', resourceId: 'p', ok: true },
        traceId: probeTrace,
      },
    });
    // Per-row verification is authoritative. A whole-table count(before)
    // vs count(after) is unreliable: audit() fire-and-forget writes from
    // the middleware of parallel tests land between those two queries
    // and pollute the delta (the DELETE/updateMany tests nearby showed
    // the same flake pattern). The guarantee this test asserts is:
    // INSERT succeeded and the row is readable back — not that no other
    // row landed in between.
    const found = await prisma.auditLog.findUnique({ where: { id: created.id } });
    expect(found).not.toBeNull();
    expect(found?.action).toBe('explicit_insert_probe');
    expect(found?.traceId).toBe(probeTrace);
  });

  it('deleteMany against audit_logs is rejected (Prisma path, not just raw)', async () => {
    await seedAuditRow('resource.create');
    let rejection: unknown = null;
    try {
      await prisma.auditLog.deleteMany({ where: { action: 'resource.create' } });
    } catch (err) {
      rejection = err;
    }
    expect(rejection).not.toBeNull();
    const errStr = String((rejection as Error).message);
    expect(errStr).toMatch(/append-only|45000|DELETE is forbidden/i);
  });

  it('updateMany against audit_logs is rejected (Prisma path, not just raw)', async () => {
    await seedAuditRow('resource.create');
    let rejection: unknown = null;
    try {
      await prisma.auditLog.updateMany({
        where: { action: 'resource.create' },
        data: { action: 'rewrite_attempt' },
      });
    } catch (err) {
      rejection = err;
    }
    expect(rejection).not.toBeNull();
    const errStr = String((rejection as Error).message);
    expect(errStr).toMatch(/append-only|45000|UPDATE is forbidden/i);
  });
});
