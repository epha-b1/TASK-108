import crypto from 'crypto';
import { getPrisma } from '../config/database';
import {
  AppError,
  NOT_FOUND,
  FORBIDDEN,
  CONFLICT,
  VALIDATION_ERROR,
} from '../utils/errors';

/* ---------- Helpers ---------- */

/**
 * Substitute `{{name}}` placeholders in a notification template body with
 * the corresponding entries in `variables`. Unmatched placeholders are
 * left intact (they're surfaced verbatim in the rendered message so an
 * operator can spot a missing variable in the delivered notification).
 *
 * Exported so the unit suite can pin the resolver behaviour without
 * having to spin up a real Prisma client. The same function is the one
 * `sendNotification` uses on the production code path.
 */
export function resolveTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}

/**
 * Maximum number of delivery attempts before an outbox entry is marked
 * as `failed` and stops retrying. Exported so test code can keep its
 * boundary expectations in lockstep with the production constant.
 */
export const MAX_OUTBOX_ATTEMPTS = 3;

/**
 * Exponential backoff schedule used by `processOutbox`. Returns the
 * delay in milliseconds before the `attempt`-th retry should fire.
 *
 *   attempt 1 →  30 s
 *   attempt 2 →  60 s
 *   attempt 3 → 120 s
 *
 * Exported so the unit suite can assert the schedule on the *real*
 * production function rather than a local replica.
 */
export function calculateBackoffMs(attempt: number): number {
  return 30 * 1000 * Math.pow(2, attempt - 1);
}

/**
 * Daily-cap policy gate. The cap is enforced inclusively (`>=`) so a
 * cap of 0 blocks immediately and a cap of N blocks the (N+1)-th send.
 * Exported so the unit suite can pin the boundary semantics.
 */
export function isDailyCapReached(dailySent: number, dailyCap: number): boolean {
  return dailySent >= dailyCap;
}

/* ---------- Template Management ---------- */

export async function createTemplate(code: string, subject: string, body: string) {
  const prisma = getPrisma();

  const existing = await prisma.notificationTemplate.findUnique({ where: { code } });
  if (existing) {
    throw new AppError(409, CONFLICT, `Template with code "${code}" already exists`);
  }

  return prisma.notificationTemplate.create({
    data: { code, subject, body },
  });
}

export async function listTemplates() {
  const prisma = getPrisma();
  return prisma.notificationTemplate.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateTemplate(
  id: string,
  data: { code?: string; subject?: string; body?: string },
) {
  const prisma = getPrisma();

  const template = await prisma.notificationTemplate.findUnique({ where: { id } });
  if (!template) throw new AppError(404, NOT_FOUND, 'Template not found');

  // If changing code, check uniqueness
  if (data.code && data.code !== template.code) {
    const dup = await prisma.notificationTemplate.findUnique({ where: { code: data.code } });
    if (dup) throw new AppError(409, CONFLICT, `Template with code "${data.code}" already exists`);
  }

  return prisma.notificationTemplate.update({
    where: { id },
    data,
  });
}

/* ---------- Send Notification ---------- */

export async function sendNotification(
  userId: string,
  type: string,
  templateCode?: string,
  variables?: Record<string, string>,
  subject?: string,
  message?: string,
) {
  const prisma = getPrisma();

  // Check user exists
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, NOT_FOUND, 'User not found');

  // Check blacklist and daily cap
  const settings = await prisma.userNotificationSetting.findUnique({
    where: { userId },
  });

  if (settings?.blacklisted) {
    throw new AppError(403, FORBIDDEN, 'User has been blacklisted from notifications');
  }

  if (settings && isDailyCapReached(settings.dailySent, settings.dailyCap)) {
    throw new AppError(429, 'RATE_LIMITED', 'Daily notification cap reached');
  }

  // Resolve template if provided
  let resolvedSubject = subject ?? null;
  let resolvedMessage = message ?? '';
  let templateId: string | null = null;

  if (templateCode) {
    const template = await prisma.notificationTemplate.findUnique({
      where: { code: templateCode },
    });
    if (!template) throw new AppError(404, NOT_FOUND, `Template "${templateCode}" not found`);

    templateId = template.id;
    const vars = variables ?? {};
    resolvedSubject = template.subject ? resolveTemplate(template.subject, vars) : resolvedSubject;
    resolvedMessage = resolveTemplate(template.body, vars);
  }

  if (!resolvedMessage) {
    throw new AppError(400, VALIDATION_ERROR, 'Either templateCode or message must be provided');
  }

  // Create notification and outbox entry in transaction
  const result = await prisma.$transaction(async (tx) => {
    const notification = await tx.notification.create({
      data: {
        userId,
        type,
        templateId,
        subject: resolvedSubject,
        message: resolvedMessage,
      },
    });

    await tx.outboxMessage.create({
      data: {
        notificationId: notification.id,
        status: 'pending',
      },
    });

    // Increment daily sent counter
    if (settings) {
      await tx.userNotificationSetting.update({
        where: { userId },
        data: { dailySent: settings.dailySent + 1 },
      });
    } else {
      await tx.userNotificationSetting.create({
        data: {
          userId,
          dailySent: 1,
        },
      });
    }

    return notification;
  });

  return result;
}

/* ---------- List & Read ---------- */

export async function listNotifications(
  userId: string,
  readFilter?: boolean,
  page?: number,
  limit?: number,
) {
  const prisma = getPrisma();
  const pg = page ?? 1;
  const lim = limit ?? 20;
  const skip = (pg - 1) * lim;

  const where: Record<string, unknown> = { userId };
  if (readFilter !== undefined) {
    where.read = readFilter;
  }

  const [data, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take: lim,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where }),
  ]);

  return { data, total, page: pg, limit: lim };
}

export async function markRead(notificationId: string, userId: string) {
  const prisma = getPrisma();

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) throw new AppError(404, NOT_FOUND, 'Notification not found');
  if (notification.userId !== userId) throw new AppError(403, FORBIDDEN, 'Access denied');

  return prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });
}

/* ---------- Stats ---------- */

export async function getStats() {
  const prisma = getPrisma();

  const [total, delivered, pending, failed] = await Promise.all([
    prisma.outboxMessage.count(),
    prisma.outboxMessage.count({ where: { status: 'delivered' } }),
    prisma.outboxMessage.count({ where: { status: 'pending' } }),
    prisma.outboxMessage.count({ where: { status: 'failed' } }),
  ]);

  return { total, delivered, pending, failed };
}

/* ---------- Outbox Processor ---------- */

export async function processOutbox() {
  const prisma = getPrisma();

  // Find pending entries that are due for processing
  const pendingEntries = await prisma.outboxMessage.findMany({
    where: {
      status: 'pending',
      OR: [
        { attempts: 0 }, // never attempted
        {
          attempts: { lt: MAX_OUTBOX_ATTEMPTS },
          notification: {
            nextRetryAt: { lte: new Date() },
          },
        },
      ],
    },
    include: { notification: true },
  });

  const results: { id: string; status: string }[] = [];

  for (const entry of pendingEntries) {
    const newAttempts = entry.attempts + 1;
    let deliverySucceeded = false;
    let errorMessage = '';

    try {
      // Local delivery adapter — in-app notification is persisted at send time,
      // so "delivery" means marking the outbox entry as processed.
      // Simulate transient failures: fail on even-numbered attempts for entries
      // that have previously failed (realistic retry testing).
      if (entry.attempts > 0 && entry.lastError) {
        // Retry of a previously-failed entry — 50% chance of transient failure
        const hash = crypto.createHash('md5').update(entry.id + String(newAttempts)).digest();
        deliverySucceeded = hash[0] % 2 === 0;
        if (!deliverySucceeded) {
          errorMessage = 'Transient delivery failure (simulated)';
        }
      } else {
        // First attempt — succeeds unless notification data is invalid
        deliverySucceeded = !!entry.notification?.message;
        if (!deliverySucceeded) {
          errorMessage = 'Empty notification message';
        }
      }
    } catch (error) {
      deliverySucceeded = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
    }

    if (deliverySucceeded) {
      await prisma.$transaction(async (tx) => {
        await tx.outboxMessage.update({
          where: { id: entry.id },
          data: { status: 'delivered', attempts: newAttempts, deliveredAt: new Date() },
        });
        await tx.notification.update({
          where: { id: entry.notificationId },
          data: { delivered: true, nextRetryAt: null },
        });
      });
      results.push({ id: entry.id, status: 'delivered' });
    } else if (newAttempts >= MAX_OUTBOX_ATTEMPTS) {
      await prisma.outboxMessage.update({
        where: { id: entry.id },
        data: { status: 'failed', attempts: newAttempts, lastError: errorMessage },
      });
      results.push({ id: entry.id, status: 'failed' });
    } else {
      // True exponential backoff: see `calculateBackoffMs` for the schedule.
      const backoffMs = calculateBackoffMs(newAttempts);
      const nextRetry = new Date(Date.now() + backoffMs);
      await prisma.$transaction(async (tx) => {
        await tx.outboxMessage.update({
          where: { id: entry.id },
          data: { attempts: newAttempts, lastError: errorMessage },
        });
        await tx.notification.update({
          where: { id: entry.notificationId },
          data: { nextRetryAt: nextRetry },
        });
      });
      results.push({ id: entry.id, status: 'retrying' });
    }
  }

  return results;
}
