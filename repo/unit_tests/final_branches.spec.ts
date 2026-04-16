/**
 * Behavior-level coverage for the edge cases in the audit-service CSV
 * exporter and the routing service's arrangement generator.
 *
 * The previous revision of this file checked only row counts + array
 * lengths. Those assertions are coverage-driven — they'd happily pass
 * even if the code dropped every data row, as long as the header + one
 * object still came back. The tests below instead validate the USER-
 * OBSERVABLE INVARIANTS the code is supposed to guarantee: CSV shape,
 * sensitive-field redaction, ordering/dedup of routing suggestions, and
 * non-negative time savings.
 */

import { exportAuditLogsCsv } from '../src/services/audit.service';
import { optimizeItinerary } from '../src/services/routing.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function resetPrisma() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

beforeEach(() => resetPrisma());

/* ====== audit.service: maskSensitiveFields + CSV shape ====== */

describe('exportAuditLogsCsv — full row contract', () => {
  it('emits the canonical header and one correctly-escaped row per log', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'r-1',
        action: 'resource.create',
        detail: {
          actorId: 'u-9',
          resourceType: 'resource',
          resourceId: 'res-1',
          safeMeta: 'keep-me',
          // Mixed sensitive field names across snake + camel casing.
          passwordHash: 'SECRET-pw',
          token_hash: 'SECRET-tok',
        },
        traceId: 'rid-1',
        createdAt: new Date('2026-04-16T12:00:00.000Z'),
      },
    ]);
    const csv = await exportAuditLogsCsv({});
    const [header, row] = csv.split('\n');

    // Canonical header order (the SIEM consumer depends on this contract).
    expect(header).toBe('id,action,actorId,resourceType,resourceId,detail,traceId,createdAt');
    // Specific column positions in the row body.
    const cols = row.split(',');
    expect(cols[0]).toBe('r-1');
    expect(cols[1]).toBe('resource.create');
    expect(cols[2]).toBe('u-9');
    expect(cols[3]).toBe('resource');
    expect(cols[4]).toBe('res-1');
    // `detail` is a JSON-encoded string, so it's wrapped in quotes and
    // doubled internal quotes. That's valid RFC 4180 CSV.
    expect(row).toContain('keep-me');
    // Sensitive fields are redacted — the original values must not leak.
    expect(row).not.toContain('SECRET-pw');
    expect(row).not.toContain('SECRET-tok');
    expect(row).toContain('REDACTED');
    // traceId and ISO timestamp end the row.
    expect(row).toContain('rid-1');
    expect(row).toContain('2026-04-16T12:00:00.000Z');
  });

  it('tolerates non-object detail values without corrupting the CSV shape', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 'a-num', action: 'x', detail: 42, traceId: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'a-str', action: 'y', detail: 'plain', traceId: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'a-nil', action: 'z', detail: null, traceId: null, createdAt: new Date('2026-01-01T00:00:00Z') },
    ] as any);
    const csv = await exportAuditLogsCsv({});
    const rows = csv.split('\n');
    // Header + 3 data rows, no "undefined" leakage, no crashes.
    expect(rows).toHaveLength(4);
    // All three rows start with their ids (i.e. the CSV did NOT collapse on
    // the non-object detail case).
    expect(rows[1].startsWith('a-num,')).toBe(true);
    expect(rows[2].startsWith('a-str,')).toBe(true);
    expect(rows[3].startsWith('a-nil,')).toBe(true);
  });
});

/* ====== routing.service: invariants callers rely on ====== */

describe('optimizeItinerary — invariants a client can observe', () => {
  it('returns valid, self-consistent suggestions even when no travel-time matrix exists', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'i1', itineraryId: 't1', resourceId: 'r1', dayNumber: 1,
        startTime: '10:00', endTime: '11:00', notes: null, position: 0,
        resource: { id: 'r1', name: 'A', city: 'Rome', region: 'IT' },
      },
    ]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    // Single-item days CANNOT have any travel — proves the short-circuit path.
    expect(s.totalTravelMinutes).toBe(0);
    expect(s.estimatedTimeSaved).toBe(0);
    // Structural contract: rank, items, dayNumber, reason.
    expect(s.rank).toBe(1);
    expect(s.dayNumber).toBe(1);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].resourceId).toBe('r1');
    expect(s.items[0].position).toBe(0);
    expect(typeof s.reason).toBe('string');
    expect(s.reason.length).toBeGreaterThan(0);
  });

  it('dedupes arrangements that produce the same ordering AND respects the ascending-travel contract', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'i1', resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
        notes: null, position: 0, resource: { id: 'r1', name: 'A', city: 'Rome', region: 'IT' },
      },
      {
        id: 'i2', resourceId: 'r2', dayNumber: 1, startTime: '11:00', endTime: '12:00',
        notes: null, position: 1, resource: { id: 'r2', name: 'B', city: 'Rome', region: 'IT' },
      },
    ]);
    // Symmetric 10-minute travel → every NN start yields the same ordering.
    prisma.travelTimeMatrix.findMany.mockResolvedValue([
      { fromResourceId: 'r1', toResourceId: 'r2', travelMinutes: 10 },
      { fromResourceId: 'r2', toResourceId: 'r1', travelMinutes: 10 },
    ]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);

    // Suggestions are sorted by totalTravelMinutes ASCENDING (public contract).
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].totalTravelMinutes)
        .toBeLessThanOrEqual(suggestions[i].totalTravelMinutes);
    }
    // Rank sequence is 1..N contiguously.
    expect(suggestions.map((s) => s.rank)).toEqual(
      suggestions.map((_, i) => i + 1),
    );
    // estimatedTimeSaved is non-negative (never "our answer is worse than yours").
    for (const s of suggestions) {
      expect(s.estimatedTimeSaved).toBeGreaterThanOrEqual(0);
    }
    // Every suggestion's ordering is a permutation of the original item ids —
    // i.e. no inventions, no drops.
    const originalIds = new Set(['i1', 'i2']);
    for (const s of suggestions) {
      expect(new Set(s.items.map((it) => it.id))).toEqual(originalIds);
      // Position mirrors the array index (the exported contract).
      s.items.forEach((it, idx) => expect(it.position).toBe(idx));
    }
    // Dedup: no two suggestions share the same item-id sequence.
    const seen = new Set<string>();
    for (const s of suggestions) {
      const key = s.items.map((it) => it.id).join('>');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
