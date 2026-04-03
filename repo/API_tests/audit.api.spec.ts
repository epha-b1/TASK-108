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
