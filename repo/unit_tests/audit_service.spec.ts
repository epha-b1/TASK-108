/**
 * Coverage for `src/services/audit.service.ts`.
 *
 * Drives every branch of:
 *   - logAction (happy + null traceId default)
 *   - audit() fire-and-forget wrapper (success + failure; success path
 *     resolves synchronously; failure path logs via auditLogger.error)
 *   - queryAuditLogs (default paging + filters: actorId / resourceType /
 *     action / date window)
 *   - exportAuditLogsCsv (header-only, value escaping for commas/quotes/
 *     newlines, sensitive-field masking, and the "extraDetail empty" branch)
 */

import { Request } from 'express';
import {
  audit,
  logAction,
  queryAuditLogs,
  exportAuditLogsCsv,
} from '../src/services/audit.service';
import { getPrisma } from '../src/config/database';
import { requestStore } from '../src/utils/logger';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  prisma.auditLog.create.mockReset();
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.count.mockReset();
});

describe('logAction', () => {
  it('writes with nested detail and null traceId default', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'a1' });
    await logAction('u1', 'resource.create', 'resource', 'r1', { name: 'X' });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'resource.create',
        detail: { actorId: 'u1', resourceType: 'resource', resourceId: 'r1', name: 'X' },
        traceId: null,
      },
    });
  });

  it('passes traceId when supplied', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'a1' });
    await logAction('u2', 'x', 'y', 'z', undefined, 'req-123');
    const call = prisma.auditLog.create.mock.calls[0][0];
    expect(call.data.traceId).toBe('req-123');
    expect(call.data.detail).toEqual({ actorId: 'u2', resourceType: 'y', resourceId: 'z' });
  });
});

describe('audit() — fire-and-forget', () => {
  function fakeReq(userId?: string): Request {
    return { user: userId ? { userId } : undefined } as unknown as Request;
  }

  it('invokes logAction with actor from req.user and ambient requestId', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'a1' });
    await requestStore.run({ requestId: 'rid-1' }, async () => {
      audit(fakeReq('uX'), 'itinerary.create', 'itinerary', 'i1', { title: 'Trip' });
      // Let the fire-and-forget microtask settle
      await Promise.resolve();
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'itinerary.create',
        detail: expect.objectContaining({ actorId: 'uX', resourceType: 'itinerary', resourceId: 'i1', title: 'Trip' }),
        traceId: 'rid-1',
      }),
    });
  });

  it('falls back to "anonymous" when req.user is missing', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'a1' });
    audit(fakeReq(), 'system.noop', 'system', 's1');
    await Promise.resolve();
    const call = prisma.auditLog.create.mock.calls[0][0];
    expect(call.data.detail.actorId).toBe('anonymous');
  });

  it('swallows logAction rejections (never throws to caller)', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    expect(() => audit(fakeReq('uX'), 'x', 'y', 'z')).not.toThrow();
    // Let rejection handler run
    await new Promise((r) => setImmediate(r));
  });
});

describe('queryAuditLogs', () => {
  it('applies default pagination and no filters', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.auditLog.count.mockResolvedValue(1);
    const result = await queryAuditLogs({});
    expect(result).toEqual({ data: [{ id: 'r1' }], total: 1, page: 1, limit: 50 });
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.take).toBe(50);
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.where).toEqual({});
  });

  it('filters by action, actorId, resourceType, and date window', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    await queryAuditLogs({
      action: 'user.login',
      actorId: 'uABC',
      resourceType: 'user',
      from: '2026-01-01',
      to: '2026-02-01',
      page: 3,
      limit: 10,
    });
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.skip).toBe(20);
    expect(call.take).toBe(10);
    expect(call.where.action).toBe('user.login');
    expect(call.where.createdAt).toEqual({ gte: new Date('2026-01-01'), lte: new Date('2026-02-01') });
    expect(Array.isArray(call.where.AND)).toBe(true);
    expect(call.where.AND).toHaveLength(2);
    expect(call.where.AND[0]).toEqual({ detail: { path: '$.actorId', equals: 'uABC' } });
    expect(call.where.AND[1]).toEqual({ detail: { path: '$.resourceType', equals: 'user' } });
  });

  it('only uses `from` when `to` is absent', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    await queryAuditLogs({ from: '2026-01-01' });
    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ gte: new Date('2026-01-01') });
  });

  it('only uses `to` when `from` is absent', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    await queryAuditLogs({ to: '2026-02-01' });
    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ lte: new Date('2026-02-01') });
  });
});

describe('exportAuditLogsCsv', () => {
  it('emits just the header row when there are no logs', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    const csv = await exportAuditLogsCsv({});
    expect(csv.trim()).toBe('id,action,actorId,resourceType,resourceId,detail,traceId,createdAt');
  });

  it('escapes commas, quotes, and newlines in fields', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1',
        action: 'x,y',
        detail: { actorId: 'a"b', resourceType: 'rt', resourceId: 'ri' },
        traceId: 'line\nbreak',
        createdAt: new Date('2026-01-02T03:04:05Z'),
      },
    ]);
    const csv = await exportAuditLogsCsv({});
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"a""b"');
    expect(csv).toContain('"line\nbreak"');
    expect(csv).toContain('2026-01-02T03:04:05.000Z');
  });

  it('redacts sensitive fields inside the detail JSON column', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a2',
        action: 'auth.change',
        detail: {
          actorId: 'u1',
          resourceType: 'user',
          resourceId: 'u1',
          passwordHash: 'secretA',
          nested: { token_hash: 'secretB' },
        },
        traceId: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    ]);
    const csv = await exportAuditLogsCsv({});
    expect(csv).not.toContain('secretA');
    expect(csv).not.toContain('secretB');
    expect(csv).toContain('REDACTED');
  });

  it('omits empty detail column when only core fields are present', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a3',
        action: 'x',
        detail: { actorId: 'u1', resourceType: 'user', resourceId: 'u1' },
        traceId: 'rid',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      },
    ]);
    const csv = await exportAuditLogsCsv({});
    // detail column (index 5) should be empty → double comma around it
    const dataRow = csv.split('\n')[1];
    expect(dataRow).toMatch(/,,rid,/);
  });

  it('tolerates a missing detail column', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a4',
        action: 'x',
        detail: null,
        traceId: null,
        createdAt: new Date('2026-01-05T00:00:00Z'),
      },
    ]);
    const csv = await exportAuditLogsCsv({});
    expect(csv.split('\n')).toHaveLength(2);
  });
});
