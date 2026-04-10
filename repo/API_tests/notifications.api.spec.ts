import request from 'supertest';
import { v4 as uuid } from 'uuid';
import app from '../src/app';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma();

const ts = Date.now();
const adminCreds = { username: `notif_admin_${ts}`, password: 'AdminPass123!x' };
const orgCreds = { username: `notif_org_${ts}`, password: 'OrgPass12345!x' };

let adminToken: string;
let orgToken: string;
let adminUserId: string;
let orgUserId: string;

let templateId: string;
let notificationId: string;

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

  // Seed `notification:read` so the organizer can list/read notifications.
  // Permission enforcement is now uniform on read routes; organizers without
  // an explicit permission point would otherwise correctly receive 403.
  const notifPp = await prisma.permissionPoint.upsert({
    where: { code: 'notification:read' },
    update: {},
    create: { code: 'notification:read' },
  });
  const orgRole = await prisma.role.upsert({
    where: { name: 'organizer' },
    update: {},
    create: { name: 'organizer', description: 'Organizer role' },
  });
  await prisma.rolePermissionPoint.upsert({
    where: { roleId_permissionPointId: { roleId: orgRole.id, permissionPointId: notifPp.id } },
    update: {},
    create: { roleId: orgRole.id, permissionPointId: notifPp.id },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: orgUserId, roleId: orgRole.id } },
    update: {},
    create: { userId: orgUserId, roleId: orgRole.id },
  });

  // Login as organizer
  const orgLogin = await request(app).post('/auth/login').set('Idempotency-Key', uuid()).send(orgCreds);
  orgToken = orgLogin.body.accessToken;
}, 15000);

afterAll(async () => {
  // Clean up notifications and related data
  if (notificationId) {
    await prisma.outboxMessage.deleteMany({ where: { notificationId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { id: notificationId } }).catch(() => {});
  }
  // Clean up any remaining notifications for test users
  for (const uid of [adminUserId, orgUserId]) {
    if (!uid) continue;
    const notifs = await prisma.notification.findMany({ where: { userId: uid } }).catch(() => []);
    for (const n of notifs) {
      await prisma.outboxMessage.deleteMany({ where: { notificationId: n.id } }).catch(() => {});
    }
    await prisma.notification.deleteMany({ where: { userId: uid } }).catch(() => {});
    await prisma.userNotificationSetting.deleteMany({ where: { userId: uid } }).catch(() => {});
  }
  // Clean up template
  if (templateId) {
    // Remove notifications referencing the template first
    await prisma.notification.updateMany({
      where: { templateId },
      data: { templateId: null },
    }).catch(() => {});
    await prisma.notificationTemplate.deleteMany({ where: { id: templateId } }).catch(() => {});
  }
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

describe('POST /notification-templates', () => {
  it('201 — creates template', async () => {
    const res = await request(app)
      .post('/notification-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        code: `test_tmpl_${ts}`,
        subject: 'Hello {{name}}',
        body: 'Dear {{name}}, your trip to {{destination}} is ready.',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.code).toBe(`test_tmpl_${ts}`);
    templateId = res.body.id;
  });
});

describe('GET /notification-templates', () => {
  it('200 — lists templates', async () => {
    const res = await request(app)
      .get('/notification-templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /notifications', () => {
  it('200 — lists (empty initially)', async () => {
    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /notifications — send notification', () => {
  it('201 — sends notification to user', async () => {
    const res = await request(app)
      .post('/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', uuid())
      .send({
        userId: orgUserId,
        type: 'info',
        message: `Test notification ${ts}`,
        subject: 'Test Subject',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.userId).toBe(orgUserId);
    notificationId = res.body.id;
  });
});

describe('PATCH /notifications/:id/read', () => {
  it('200 — marks as read', async () => {
    const res = await request(app)
      .patch(`/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${orgToken}`)
      .set('Idempotency-Key', uuid());
    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
  });
});

describe('GET /notifications/stats', () => {
  it('200 — admin gets stats', async () => {
    const res = await request(app)
      .get('/notifications/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeDefined();
    expect(typeof res.body.total).toBe('number');
    expect(res.body.delivered).toBeDefined();
    expect(res.body.pending).toBeDefined();
    expect(res.body.failed).toBeDefined();
  });

  it('403 — organizer cannot get stats', async () => {
    const res = await request(app)
      .get('/notifications/stats')
      .set('Authorization', `Bearer ${orgToken}`);
    expect(res.status).toBe(403);
  });
});
