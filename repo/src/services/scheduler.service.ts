import cron from 'node-cron';
import { getPrisma } from '../config/database';
import { processOutbox } from './notification.service';
import { logger } from '../utils/logger';

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
        logger.info('Outbox processed', { count: results.length, results });
      }
    } catch (err) {
      logger.error('Outbox processing failed', { error: (err as Error).message });
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
      logger.info('Daily notification cap reset', { count: result.count });
    } catch (err) {
      logger.error('Daily cap reset failed', { error: (err as Error).message });
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
        logger.info('Expired idempotency keys cleaned', { count: result.count });
      }
    } catch (err) {
      logger.error('Idempotency cleanup failed', { error: (err as Error).message });
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
        logger.info('Expired refresh tokens cleaned', { count: result.count });
      }
    } catch (err) {
      logger.error('Refresh token cleanup failed', { error: (err as Error).message });
    }
  });

  logger.info('Background scheduler started');
}

export function stopScheduler(): void {
  outboxTask?.stop();
  capResetTask?.stop();
  idempotencyCleanupTask?.stop();
  refreshTokenCleanupTask?.stop();
  logger.info('Background scheduler stopped');
}
