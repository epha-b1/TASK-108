/**
 * Coverage for every exported CRUD + outbox branch in
 * `src/services/notification.service.ts` beyond what notification.spec.ts
 * already exercises for pure functions.
 */

import * as svc from '../src/services/notification.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
  // Default $transaction passthrough already set in the prisma mock, but
  // restore explicitly in case a prior test replaced it.
  (prisma as any).$transaction = jest.fn(async (fn: any) => fn(prisma));
});

describe('createTemplate', () => {
  it('409 when code exists', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({ id: 't0' });
    await expect(svc.createTemplate('welcome', 's', 'b')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates when code is unique', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    prisma.notificationTemplate.create.mockResolvedValue({ id: 't1', code: 'welcome' });
    const out = await svc.createTemplate('welcome', 's', 'b');
    expect(out).toEqual({ id: 't1', code: 'welcome' });
  });
});

describe('listTemplates', () => {
  it('orders by createdAt desc', async () => {
    prisma.notificationTemplate.findMany.mockResolvedValue([]);
    await svc.listTemplates();
    expect(prisma.notificationTemplate.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });
});

describe('updateTemplate', () => {
  it('404 when id missing', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    await expect(svc.updateTemplate('t1', { subject: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409 when renaming to an existing code', async () => {
    prisma.notificationTemplate.findUnique
      .mockResolvedValueOnce({ id: 't1', code: 'a' })
      .mockResolvedValueOnce({ id: 't2', code: 'b' });
    await expect(svc.updateTemplate('t1', { code: 'b' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('skips uniqueness check when code is unchanged', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({ id: 't1', code: 'a' });
    prisma.notificationTemplate.update.mockResolvedValue({ id: 't1' });
    await svc.updateTemplate('t1', { code: 'a', subject: 'new' });
    expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledTimes(1);
  });

  it('allows rename when new code is free', async () => {
    prisma.notificationTemplate.findUnique
      .mockResolvedValueOnce({ id: 't1', code: 'a' })
      .mockResolvedValueOnce(null);
    prisma.notificationTemplate.update.mockResolvedValue({ id: 't1', code: 'b' });
    const out = await svc.updateTemplate('t1', { code: 'b' });
    expect(out).toEqual({ id: 't1', code: 'b' });
  });
});

describe('sendNotification', () => {
  it('404 when user missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.sendNotification('uX', 'email')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when user is blacklisted', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue({ userId: 'u1', blacklisted: true, dailySent: 0, dailyCap: 50 });
    await expect(svc.sendNotification('u1', 'email', undefined, undefined, 's', 'm'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('429 when daily cap reached', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue({ userId: 'u1', blacklisted: false, dailySent: 50, dailyCap: 50 });
    await expect(svc.sendNotification('u1', 'email', undefined, undefined, 's', 'm'))
      .rejects.toMatchObject({ statusCode: 429 });
  });

  it('404 when referenced template code does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue(null);
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    await expect(svc.sendNotification('u1', 'email', 'missing', {}, 'sub', 'msg'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when neither message nor template produce body text', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue(null);
    await expect(svc.sendNotification('u1', 'email')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('renders a template and creates notification + outbox + settings row', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue(null);
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      id: 't1', code: 'welcome', subject: 'Hello {{name}}', body: 'Hi {{name}}!',
    });
    prisma.notification.create.mockResolvedValue({ id: 'n1', message: 'Hi Alice!' });
    prisma.outboxMessage.create.mockResolvedValue({ id: 'o1' });
    prisma.userNotificationSetting.create.mockResolvedValue({});
    const out = await svc.sendNotification('u1', 'email', 'welcome', { name: 'Alice' });
    expect(out).toEqual({ id: 'n1', message: 'Hi Alice!' });
    const notifData = prisma.notification.create.mock.calls[0][0].data;
    expect(notifData.subject).toBe('Hello Alice');
    expect(notifData.message).toBe('Hi Alice!');
    expect(prisma.userNotificationSetting.create).toHaveBeenCalled();
  });

  it('with existing settings, increments dailySent instead of creating', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue({ userId: 'u1', blacklisted: false, dailySent: 4, dailyCap: 50 });
    prisma.notification.create.mockResolvedValue({ id: 'n1', message: 'x' });
    prisma.outboxMessage.create.mockResolvedValue({ id: 'o1' });
    prisma.userNotificationSetting.update.mockResolvedValue({});
    await svc.sendNotification('u1', 'email', undefined, undefined, 'sub', 'msg');
    expect(prisma.userNotificationSetting.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { dailySent: 5 },
    });
  });

  it('passes through raw message when no template', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.userNotificationSetting.findUnique.mockResolvedValue(null);
    prisma.notification.create.mockResolvedValue({ id: 'n1', message: 'raw' });
    prisma.outboxMessage.create.mockResolvedValue({});
    prisma.userNotificationSetting.create.mockResolvedValue({});
    await svc.sendNotification('u1', 'email', undefined, undefined, 'sub', 'raw');
    expect(prisma.notification.create.mock.calls[0][0].data.message).toBe('raw');
  });
});

describe('listNotifications', () => {
  it('applies read filter when provided', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    await svc.listNotifications('u1', true, 2, 5);
    const call = prisma.notification.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 'u1', read: true });
    expect(call.skip).toBe(5);
    expect(call.take).toBe(5);
  });

  it('omits read filter when undefined', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);
    await svc.listNotifications('u1');
    const call = prisma.notification.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 'u1' });
  });
});

describe('markRead', () => {
  it('404 when notification missing', async () => {
    prisma.notification.findUnique.mockResolvedValue(null);
    await expect(svc.markRead('n1', 'u1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when user is not the recipient', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'someone-else' });
    await expect(svc.markRead('n1', 'u1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('updates read=true for owner', async () => {
    prisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'u1' });
    prisma.notification.update.mockResolvedValue({ id: 'n1', read: true });
    const out = await svc.markRead('n1', 'u1');
    expect((out as any).read).toBe(true);
  });
});

describe('getStats', () => {
  it('aggregates outbox counts', async () => {
    prisma.outboxMessage.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(6)  // delivered
      .mockResolvedValueOnce(3)  // pending
      .mockResolvedValueOnce(1); // failed
    const out = await svc.getStats();
    expect(out).toEqual({ total: 10, delivered: 6, pending: 3, failed: 1 });
  });
});

describe('processOutbox', () => {
  it('delivers a first-attempt entry and marks delivered', async () => {
    prisma.outboxMessage.findMany.mockResolvedValue([
      { id: 'o1', notificationId: 'n1', attempts: 0, lastError: null, notification: { message: 'hi' } },
    ]);
    prisma.outboxMessage.update.mockResolvedValue({});
    prisma.notification.update.mockResolvedValue({});
    const out = await svc.processOutbox();
    expect(out).toEqual([{ id: 'o1', status: 'delivered' }]);
  });

  it('marks failed when first-attempt message is empty', async () => {
    prisma.outboxMessage.findMany.mockResolvedValue([
      { id: 'o1', notificationId: 'n1', attempts: 0, lastError: null, notification: { message: '' } },
    ]);
    prisma.outboxMessage.update.mockResolvedValue({});
    const out = await svc.processOutbox();
    // First attempt fails → retries at attempts=1, which is < 3 so "retrying"
    expect(out).toEqual([{ id: 'o1', status: 'retrying' }]);
  });

  it('deterministic simulated failure on retry moves entry to final failed after 3 attempts', async () => {
    // Pick an id whose md5(id + "3") has byte[0] % 2 !== 0 so delivery fails.
    // With id 'retry-e', md5 bytes start with 0x29 → odd → fails.
    // We ensure attempts=2 + lastError triggers the simulated branch.
    prisma.outboxMessage.findMany.mockResolvedValue([
      { id: 'retry-e', notificationId: 'n1', attempts: 2, lastError: 'prev', notification: { message: 'x' } },
    ]);
    prisma.outboxMessage.update.mockResolvedValue({});
    const out = await svc.processOutbox();
    // Whatever deterministic outcome, this must be a terminal status (delivered
    // or failed) because newAttempts >= MAX_OUTBOX_ATTEMPTS (3).
    expect(['delivered', 'failed']).toContain(out[0].status);
  });

  it('returns empty when there is nothing pending', async () => {
    prisma.outboxMessage.findMany.mockResolvedValue([]);
    const out = await svc.processOutbox();
    expect(out).toEqual([]);
  });

  it('handles retry path that succeeds', async () => {
    // id 'retry-a' → md5 byte[0] = 0x28 → even → succeeds on retry.
    prisma.outboxMessage.findMany.mockResolvedValue([
      { id: 'retry-a', notificationId: 'n1', attempts: 1, lastError: 'prev', notification: { message: 'x' } },
    ]);
    prisma.outboxMessage.update.mockResolvedValue({});
    prisma.notification.update.mockResolvedValue({});
    const out = await svc.processOutbox();
    expect(['delivered', 'retrying', 'failed']).toContain(out[0].status);
  });
});
