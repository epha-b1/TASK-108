import { Request } from 'express';
import { getPrisma } from '../config/database';
import { Prisma } from '../models/prisma';
import { getRequestId, auditLog as auditLogger } from '../utils/logger';

/* ---------- Types ---------- */

interface AuditFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  from?: string | Date;
  to?: string | Date;
  page?: number;
  limit?: number;
}

/* ---------- Sensitive Field Masking ---------- */

const SENSITIVE_FIELDS = ['password_hash', 'passwordHash', 'answer_encrypted', 'answerEncrypted', 'tokenHash', 'token_hash'];

function maskSensitiveFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveFields);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.includes(key)) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = maskSensitiveFields(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return obj;
}

/* ---------- Build Where Clause ---------- */

function buildWhereClause(filters: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  const andConditions: Prisma.AuditLogWhereInput[] = [];

  if (filters.action) {
    where.action = filters.action;
  }

  if (filters.from || filters.to) {
    const createdAt: Record<string, Date> = {};
    if (filters.from) createdAt.gte = new Date(filters.from);
    if (filters.to) createdAt.lte = new Date(filters.to);
    where.createdAt = createdAt;
  }

  // actorId and resourceType are stored inside the detail JSON field
  if (filters.actorId) {
    andConditions.push({
      detail: {
        path: '$.actorId',
        equals: filters.actorId,
      },
    });
  }

  if (filters.resourceType) {
    andConditions.push({
      detail: {
        path: '$.resourceType',
        equals: filters.resourceType,
      },
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

/* ---------- Exports ---------- */

export async function logAction(
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  detail?: Record<string, unknown>,
  traceId?: string,
) {
  const prisma = getPrisma();

  return prisma.auditLog.create({
    data: {
      action,
      detail: {
        actorId,
        resourceType,
        resourceId,
        ...(detail ?? {}),
      },
      // Schema column is still named `traceId` for migration stability, but
      // semantically it carries the canonical requestId.
      traceId: traceId ?? null,
    },
  });
}

/**
 * Centralised audit emitter for controllers.
 *
 * Wraps `logAction` so call sites don't have to:
 *   - thread the actor id manually,
 *   - look up the current request id,
 *   - or remember to swallow errors so audit failures never break requests.
 *
 * Usage from a controller:
 *
 *     await audit(req, 'resource.create', 'resource', resource.id, { name });
 *
 * The `req` argument provides the actor (req.user!.userId) so we never log
 * mutations performed by anonymous routes (caller is responsible for not
 * calling this on public endpoints).
 */
export function audit(
  req: Request,
  action: string,
  resourceType: string,
  resourceId: string,
  detail?: Record<string, unknown>,
): void {
  const actorId = req.user?.userId ?? 'anonymous';
  const requestId = getRequestId();
  // Fire-and-forget — failure to write an audit row must never block a
  // user-facing mutation, but we DO want it surfaced in the structured logs
  // so an alert can be wired off log volume.
  logAction(actorId, action, resourceType, resourceId, detail, requestId).catch((err) => {
    auditLogger.error('audit log write failed', {
      action,
      resourceType,
      resourceId,
      error: (err as Error).message,
    });
  });
}

export async function queryAuditLogs(filters: AuditFilters) {
  const prisma = getPrisma();

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const skip = (page - 1) * limit;

  const where = buildWhereClause(filters);

  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function exportAuditLogsCsv(filters: AuditFilters): Promise<string> {
  const prisma = getPrisma();

  // For CSV export, fetch all matching records (no pagination)
  const where = buildWhereClause(filters);

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  // CSV header
  const headers = ['id', 'action', 'actorId', 'resourceType', 'resourceId', 'detail', 'traceId', 'createdAt'];
  const rows: string[] = [headers.join(',')];

  for (const log of logs) {
    const detail = (log.detail ?? {}) as Record<string, unknown>;
    const maskedDetail = maskSensitiveFields(detail) as Record<string, unknown>;

    const actorId = maskedDetail.actorId ?? '';
    const resourceType = maskedDetail.resourceType ?? '';
    const resourceId = maskedDetail.resourceId ?? '';

    // Remove actorId/resourceType/resourceId from detail for the detail column
    const extraDetail = { ...maskedDetail };
    delete extraDetail.actorId;
    delete extraDetail.resourceType;
    delete extraDetail.resourceId;

    const detailStr = Object.keys(extraDetail).length > 0
      ? JSON.stringify(extraDetail)
      : '';

    const row = [
      csvEscape(log.id),
      csvEscape(log.action),
      csvEscape(String(actorId)),
      csvEscape(String(resourceType)),
      csvEscape(String(resourceId)),
      csvEscape(detailStr),
      csvEscape(log.traceId ?? ''),
      csvEscape(log.createdAt.toISOString()),
    ];

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

/* ---------- CSV Utility ---------- */

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
