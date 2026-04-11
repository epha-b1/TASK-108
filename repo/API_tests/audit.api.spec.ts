import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `audit_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `audit_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

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

describe('GET /audit-logs', () => {
  it('200 — admin can query', async () => {
    const res = await request(app)
      .get('/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeDefined();
    expect(typeof res.body.total).toBe('number');
    expect(res.body.page).toBeDefined();
    expect(res.body.limit).toBeDefined();
  });

  it('403 — organizer cannot query', async () => {
    const res = await request(app)
      .get('/audit-logs')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /audit-logs/export', () => {
  it('200 — returns CSV with sensitive fields masked', async () => {
    // First create an audit log entry with sensitive data by triggering a login
    await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);

    const res = await request(app)
      .get('/audit-logs/export')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/audit-logs\.csv/);
    expect(typeof res.text).toBe('string');
    expect(res.text).toContain('id,action,actorId');

    // Sensitive fields must never appear in plain text
    expect(res.text).not.toMatch(/password_hash|answerEncrypted|tokenHash/);
    // If any sensitive data was logged, it should be redacted
    const lines = res.text.split('\n').filter((l: string) => l.trim());
    if (lines.length > 1) {
      // Verify the CSV is parseable and no raw secrets leak
      for (const line of lines.slice(1)) {
        expect(line).not.toMatch(/\$2[aby]\$/); // bcrypt hash pattern
      }
    }
  });
});

// === Audit completeness for representative critical mutations ===
// For each protected mutating endpoint we now add a centralised audit() call.
// These tests prove the row actually lands in audit_logs by querying it back
// through GET /audit-logs.
describe('Audit completeness — critical mutations', () => {
  /**
   * Poll /audit-logs until a row matching the predicate is found, or a
   * deadline elapses. We poll (rather than do a single fixed-delay
   * query) because the audit() helper is fire-and-forget on the
   * controller side — the HTTP response can return BEFORE the audit row
   * is committed, especially on slow Windows/WSL hosts.
   *
   * The predicate must filter by something specific to *this* test
   * (e.g. detail.resourceId = the user/resource we just created). The
   * audit_logs table is append-only at the DB level (immutability
   * triggers), so previous runs' rows can persist in the volume and a
   * naive `find(row => row.action === X)` would happily return one of
   * them and assert against the wrong row.
   */
  async function pollAuditRow(
    predicate: (row: { action: string; detail: Record<string, unknown> }) => boolean,
    { timeoutMs = 5000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ action: string; detail: Record<string, unknown> } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app)
        .get('/audit-logs?limit=200')
        .set('Authorization', `Bearer ${adminToken}`);
      if (res.status === 200) {
        const match = (res.body.data ?? []).find(predicate);
        if (match) return match;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function findAuditAction(action: string): Promise<{ action: string; detail: Record<string, unknown> } | null> {
    // Action-only variant kept for the existing resource/template/model
    // tests below — they create unique-per-run resources, so any matching
    // action row from THIS run is acceptable.
    return pollAuditRow((row) => row.action === action);
  }

  it('resource.create lands in audit_logs after POST /resources', async () => {
    const create = await request(app)
      .post('/resources')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `Audit Res ${ts}`, type: 'attraction', city: 'TestCity' });
    expect(create.status).toBe(201);

    const row = await findAuditAction('resource.create');
    expect(row).not.toBeNull();
    expect((row!.detail as { resourceType: string }).resourceType).toBe('resource');

    // cleanup
    await prisma.resource.delete({ where: { id: create.body.id } }).catch(() => {});
  });

  it('notification.template.create lands in audit_logs', async () => {
    const code = `audit_template_${ts}`;
    const create = await request(app)
      .post('/notification-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ code, subject: 'S', body: 'Hello {{name}}' });
    expect(create.status).toBe(201);

    const row = await findAuditAction('notification.template.create');
    expect(row).not.toBeNull();

    await prisma.notificationTemplate.delete({ where: { id: create.body.id } }).catch(() => {});
  });

  it('model.register lands in audit_logs', async () => {
    const create = await request(app)
      .post('/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ name: `audit_model_${ts}`, version: '1.0.0', type: 'pmml' });
    expect(create.status).toBe(201);

    const row = await findAuditAction('model.register');
    expect(row).not.toBeNull();

    await prisma.mlModel.delete({ where: { id: create.body.id } }).catch(() => {});
  });

  it('user.update lands in audit_logs after PATCH /users/:id', async () => {
    // Create a throw-away user to update — use uuid() suffix instead of `ts`
    // so this test stays deterministic even if a previous run on a stale
    // volume already left an `audit_usr_upd_${ts}` row in the audit table.
    const userCreds = {
      username: `audit_usr_upd_${ts}_${uuid().slice(0, 8)}`,
      password: 'AuditUserUpd123!x',
    };
    const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      ...userCreds,
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
    const uid = reg.body.id;

    await request(app)
      .patch(`/users/${uid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({ status: 'suspended' });

    // Poll for the row scoped to THIS user's id — this is robust against
    // (a) the fire-and-forget audit() helper not having flushed yet, and
    // (b) prior-run rows with the same `user.update` action sitting in
    //     audit_logs (which is append-only at the DB level).
    const row = await pollAuditRow(
      (r) => r.action === 'user.update' && (r.detail as { resourceId?: string }).resourceId === uid,
    );
    expect(row).not.toBeNull();
    expect((row!.detail as { newStatus: string }).newStatus).toBe('suspended');

    // cleanup
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.device.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.securityQuestion.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.passwordHistory.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {});
  });

  it('user.delete lands in audit_logs after DELETE /users/:id', async () => {
    const userCreds = {
      username: `audit_usr_del_${ts}_${uuid().slice(0, 8)}`,
      password: 'AuditUserDel123!x',
    };
    const reg = await request(app).post('/auth/register').set('Idempotency-Key', uuid()).send({
      ...userCreds,
      securityQuestions: [{ question: 'Q1?', answer: 'a1' }, { question: 'Q2?', answer: 'a2' }],
    });
    const uid = reg.body.id;

    await request(app)
      .delete(`/users/${uid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid());

    // Same poll-by-resource-id pattern — see the user.update test above.
    const row = await pollAuditRow(
      (r) => r.action === 'user.delete' && (r.detail as { resourceId?: string }).resourceId === uid,
    );
    expect(row).not.toBeNull();
    expect((row!.detail as { username: string }).username).toBe(userCreds.username);
  });
});

// === Audit immutability ===
// audit_logs is append-only at the database layer. Triggers installed by the
// 20260409000000_audit_immutability migration raise SQLSTATE 45000 on any
// UPDATE or DELETE attempt. We exercise both via raw SQL through Prisma.
describe('Audit immutability — DB-level enforcement', () => {
  it('UPDATE on audit_logs is rejected by trigger', async () => {
    // Trigger a write so there's at least one row
    await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(adminCreds);
    const row = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();

    let threw = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'tampered' WHERE id = '${row!.id}'`,
      );
    } catch (err) {
      threw = true;
      expect(String((err as Error).message)).toMatch(/append-only|forbidden|45000/i);
    }
    expect(threw).toBe(true);
  });

  it('DELETE on audit_logs is rejected by trigger', async () => {
    const row = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();

    let threw = false;
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${row!.id}'`);
    } catch (err) {
      threw = true;
      expect(String((err as Error).message)).toMatch(/append-only|forbidden|45000/i);
    }
    expect(threw).toBe(true);
  });
});
