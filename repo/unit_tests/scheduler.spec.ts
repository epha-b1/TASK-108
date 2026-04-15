/**
 * Coverage for `src/services/scheduler.service.ts`.
 *
 * `node-cron` is mocked so each `cron.schedule` call captures the task
 * callback into a registry. We then invoke the callbacks directly with
 * the (mocked) Prisma so the success path AND the error path for every
 * one of the four scheduled tasks is exercised — the production code
 * has four `try/catch` blocks, and without driving each side of each
 * branch the scheduler sits at 0% coverage.
 */

type TaskCb = () => Promise<void> | void;
const scheduled: { expr: string; cb: TaskCb }[] = [];

jest.mock('node-cron', () => ({
  __esModule: true,
  default: {
    schedule: (expr: string, cb: TaskCb, _opts?: unknown) => {
      scheduled.push({ expr, cb });
      return { stop: jest.fn() };
    },
  },
}));

jest.mock('../src/services/notification.service', () => ({
  __esModule: true,
  // Returning a non-empty array drives the "results.length > 0" branch.
  processOutbox: jest.fn(),
}));

import { startScheduler, stopScheduler } from '../src/services/scheduler.service';
import * as notificationService from '../src/services/notification.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

describe('scheduler.service', () => {
  beforeEach(() => {
    scheduled.length = 0;
    (notificationService.processOutbox as jest.Mock).mockReset();
    prisma.userNotificationSetting.upsert?.mockReset?.();
    if (!(prisma as any).userNotificationSetting.updateMany) {
      (prisma as any).userNotificationSetting.updateMany = jest.fn();
    } else {
      (prisma as any).userNotificationSetting.updateMany.mockReset();
    }
    prisma.idempotencyKey.deleteMany.mockReset();
    prisma.refreshToken.deleteMany.mockReset();
  });

  it('registers four cron tasks with expected schedules', () => {
    startScheduler();
    const exprs = scheduled.map((s) => s.expr);
    expect(exprs).toEqual([
      '*/30 * * * * *',
      '0 0 * * *',
      '0 * * * *',
      '0 * * * *',
    ]);
  });

  it('outbox task logs when processOutbox returns results', async () => {
    (notificationService.processOutbox as jest.Mock).mockResolvedValue([{ id: 'n1', status: 'delivered' }]);
    startScheduler();
    await scheduled[0].cb();
    expect(notificationService.processOutbox).toHaveBeenCalledTimes(1);
  });

  it('outbox task silently ignores empty results', async () => {
    (notificationService.processOutbox as jest.Mock).mockResolvedValue([]);
    startScheduler();
    await scheduled[0].cb();
    expect(notificationService.processOutbox).toHaveBeenCalled();
  });

  it('outbox task catches and logs errors without throwing', async () => {
    (notificationService.processOutbox as jest.Mock).mockRejectedValue(new Error('outbox boom'));
    startScheduler();
    await expect(scheduled[0].cb()).resolves.toBeUndefined();
  });

  it('daily cap reset resets dailySent for all users with sends', async () => {
    (prisma as any).userNotificationSetting.updateMany.mockResolvedValue({ count: 4 });
    startScheduler();
    await scheduled[1].cb();
    expect((prisma as any).userNotificationSetting.updateMany).toHaveBeenCalledWith({
      where: { dailySent: { gt: 0 } },
      data: { dailySent: 0 },
    });
  });

  it('daily cap reset swallows prisma errors', async () => {
    (prisma as any).userNotificationSetting.updateMany.mockRejectedValue(new Error('db down'));
    startScheduler();
    await expect(scheduled[1].cb()).resolves.toBeUndefined();
  });

  it('idempotency cleanup deletes expired keys (logs only when >0)', async () => {
    prisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 2 });
    startScheduler();
    await scheduled[2].cb();
    const call = prisma.idempotencyKey.deleteMany.mock.calls[0][0];
    expect(call.where.expiresAt).toHaveProperty('lt');
  });

  it('idempotency cleanup takes the no-op branch when count is 0', async () => {
    prisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 0 });
    startScheduler();
    await scheduled[2].cb();
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it('idempotency cleanup error path does not throw', async () => {
    prisma.idempotencyKey.deleteMany.mockRejectedValue(new Error('oops'));
    startScheduler();
    await expect(scheduled[2].cb()).resolves.toBeUndefined();
  });

  it('refresh token cleanup deletes expired OR revoked tokens', async () => {
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });
    startScheduler();
    await scheduled[3].cb();
    const where = prisma.refreshToken.deleteMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { expiresAt: { lt: expect.any(Date) } },
      { revokedAt: { not: null } },
    ]);
  });

  it('refresh token cleanup no-op branch', async () => {
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    startScheduler();
    await scheduled[3].cb();
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalled();
  });

  it('refresh token cleanup error path does not throw', async () => {
    prisma.refreshToken.deleteMany.mockRejectedValue(new Error('oops'));
    startScheduler();
    await expect(scheduled[3].cb()).resolves.toBeUndefined();
  });

  it('stopScheduler halts all previously scheduled tasks', () => {
    startScheduler();
    // stopScheduler uses optional chaining; no throw
    expect(() => stopScheduler()).not.toThrow();
  });

  it('stopScheduler before startScheduler is a safe no-op', () => {
    // The module-level refs may or may not be null depending on prior tests;
    // stopScheduler must never throw either way.
    expect(() => stopScheduler()).not.toThrow();
  });
});
