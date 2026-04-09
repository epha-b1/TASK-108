import cron from 'node-cron';
import { getPrisma } from '../config/database';
import { processOutbox } from './notification.service';
import { systemLog, notificationLog, authLog } from '../utils/logger';

let outboxTask: cron.ScheduledTask | null = null;
let capResetTask: cron.ScheduledTask | null = null;
let idempotencyCleanupTask: cron.ScheduledTask | null = null;
let refreshTokenCleanupTask: cron.ScheduledTask | null = null;

export function startScheduler(): void {
  // Outbox processor — every 30 seconds
  outboxTask = cron.schedule('*/30 * * * * *', async () => {
    try {
      const results = await processOutbox();
      if (results.length > 0) {
        notificationLog.info('outbox processed', { count: results.length, results });
      }
    } catch (err) {
      notificationLog.error('outbox processing failed', { error: (err as Error).message });
    }
  });

  // Daily notification cap reset — midnight UTC
  capResetTask = cron.schedule('0 0 * * *', async () => {
    try {
      const prisma = getPrisma();
      const result = await prisma.userNotificationSetting.updateMany({
        where: { dailySent: { gt: 0 } },
        data: { dailySent: 0 },
      });
      notificationLog.info('daily notification cap reset', { count: result.count });
    } catch (err) {
      notificationLog.error('daily cap reset failed', { error: (err as Error).message });
    }
  }, { timezone: 'UTC' });

  // Idempotency key cleanup — every hour
  idempotencyCleanupTask = cron.schedule('0 * * * *', async () => {
    try {
      const prisma = getPrisma();
      const result = await prisma.idempotencyKey.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        systemLog.info('expired idempotency keys cleaned', { count: result.count });
      }
    } catch (err) {
      systemLog.error('idempotency cleanup failed', { error: (err as Error).message });
    }
  });

  // Refresh token cleanup — every hour
  refreshTokenCleanupTask = cron.schedule('0 * * * *', async () => {
    try {
      const prisma = getPrisma();
      const result = await prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date() } },
            { revokedAt: { not: null } },
          ],
        },
      });
      if (result.count > 0) {
        authLog.info('expired refresh tokens cleaned', { count: result.count });
      }
    } catch (err) {
      authLog.error('refresh token cleanup failed', { error: (err as Error).message });
    }
  });

  systemLog.info('background scheduler started');
}

export function stopScheduler(): void {
  outboxTask?.stop();
  capResetTask?.stop();
  idempotencyCleanupTask?.stop();
  refreshTokenCleanupTask?.stop();
  systemLog.info('background scheduler stopped');
}
