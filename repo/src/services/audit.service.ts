import { getPrisma } from '../config/database';
import { Prisma } from '../models/prisma';

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
      traceId: traceId ?? null,
    },
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
