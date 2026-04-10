/**
 * Unit tests for the itinerary service.
 *
 * These exercise the REAL functions in src/services/itinerary.service.ts via
 * the in-memory Prisma mock at src/__mocks__/prisma.ts. The previous version
 * of this file replicated the validation helpers locally and tested those
 * copies — that gave green CI even when the real service drifted away from
 * the spec, which is exactly the failure mode the audit flagged.
 *
 * What we cover:
 *   - validateItem business rules (overlap, buffer, dwell, hours, closure,
 *     travel time) via addItem.
 *   - createVersion snapshot fidelity: metadata + items both present and
 *     diff metadata reports both kinds of change.
 *   - every PATCH (including status-only) cuts a versioned revision record,
 *     per the prompt requirement that "every save creates a versioned
 *     revision record". The status-only path is asserted explicitly so
 *     a regression that drops it would fail this test.
 *
 * Where the service does ownership / role checks we pass an "admin" role so
 * the test stays focused on the business logic and not authz wiring.
 */

import * as itineraryService from '../src/services/itinerary.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function reset() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock).mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

const FIXED_START = new Date('2026-06-01T00:00:00.000Z');

function makeItinerary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'itin-1',
    ownerId: 'user-1',
    title: 'Trip',
    destination: 'Paris',
    startDate: FIXED_START,
    endDate: new Date('2026-06-05T00:00:00.000Z'),
    status: 'draft',
    createdAt: FIXED_START,
    updatedAt: FIXED_START,
    ...overrides,
  };
}

function makeResource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'res-1',
    name: 'Eiffel',
    type: 'attraction',
    minDwellMinutes: 30,
    hours: [],
    closures: [],
    ...overrides,
  };
}

beforeEach(() => reset());

describe('itinerary.service.addItem — validateItem rules', () => {
  it('rejects an item shorter than the resource min dwell time', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource({ minDwellMinutes: 60 }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '09:00',
        endTime: '09:30', // only 30 min, need 60
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects when item time is outside the resource business hours', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(
      makeResource({
        hours: [
          { id: 'h1', resourceId: 'res-1', dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' },
        ],
      }),
    );
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    // 2026-06-01 is a Monday (dayOfWeek=1), itinerary day 1 → that Monday.
    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '07:00',
        endTime: '08:00',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('rejects when the resource is closed on the actual date', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(
      makeResource({
        closures: [{ id: 'c1', resourceId: 'res-1', date: new Date('2026-06-01'), reason: 'Holiday' }],
      }),
    );
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '10:00',
        endTime: '11:00',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('rejects an item that overlaps an existing item on the same day', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'it1',
        itineraryId: 'itin-1',
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '09:00',
        endTime: '10:00',
        notes: null,
        position: 0,
        resource: makeResource(),
      },
    ]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '09:30',
        endTime: '10:30',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('rejects items closer than the 15-minute buffer', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'it1',
        itineraryId: 'itin-1',
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '09:00',
        endTime: '10:00',
        notes: null,
        position: 0,
        resource: makeResource(),
      },
    ]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '10:05',
        endTime: '11:00',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('rejects when travel time from previous item exceeds the gap', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'it1',
        itineraryId: 'itin-1',
        resourceId: 'res-9',
        dayNumber: 1,
        startTime: '09:00',
        endTime: '10:00',
        notes: null,
        position: 0,
        resource: makeResource({ id: 'res-9' }),
      },
    ]);
    // 30-minute travel time but we're scheduling at 10:20 (only 20-minute gap).
    prisma.travelTimeMatrix.findFirst.mockResolvedValue({
      id: 'tt1',
      fromResourceId: 'res-9',
      toResourceId: 'res-1',
      transportMode: 'walking',
      travelMinutes: 30,
    });

    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '10:20',
        endTime: '11:00',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('rejects when travel time to the NEXT item exceeds the gap (new→next check)', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    // Existing item at 14:00-15:00 using resource 'res-9' (this is the "next" item).
    prisma.itineraryItem.findMany.mockResolvedValue([
      {
        id: 'next-item',
        itineraryId: 'itin-1',
        resourceId: 'res-9',
        dayNumber: 1,
        startTime: '14:00',
        endTime: '15:00',
        notes: null,
        position: 0,
        resource: makeResource({ id: 'res-9' }),
      },
    ]);
    // No previous item ends before 12:00 so the prev→new lookup is skipped.
    // The ONLY findFirst call is new→next: res-1 → res-9 = 45 min.
    prisma.travelTimeMatrix.findFirst.mockResolvedValue({
      id: 'tt2',
      fromResourceId: 'res-1',
      toResourceId: 'res-9',
      transportMode: 'walking',
      travelMinutes: 45,
    });

    // New item 12:00-13:30, gap to next (14:00) = 30 min, need 45 → reject.
    await expect(
      itineraryService.addItem('itin-1', 'user-1', 'admin', {
        resourceId: 'res-1',
        dayNumber: 1,
        startTime: '12:00',
        endTime: '13:30',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('accepts a well-spaced item and persists it via prisma.itineraryItem.create', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);

    const created = {
      id: 'new-item',
      itineraryId: 'itin-1',
      resourceId: 'res-1',
      dayNumber: 1,
      startTime: '14:00',
      endTime: '15:00',
      notes: null,
      position: 0,
      resource: makeResource(),
    };
    prisma.itineraryItem.create.mockResolvedValue(created);
    // createVersion calls
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({ versionNumber: 1 });

    const result = await itineraryService.addItem('itin-1', 'user-1', 'admin', {
      resourceId: 'res-1',
      dayNumber: 1,
      startTime: '14:00',
      endTime: '15:00',
    });

    expect(result.id).toBe('new-item');
    expect(prisma.itineraryItem.create).toHaveBeenCalled();
    expect(prisma.itineraryVersion.create).toHaveBeenCalled();
  });
});

describe('itinerary.service.updateItinerary — versioning', () => {
  it('cuts a new version on a status-only update with a status diff entry', async () => {
    prisma.itinerary.findUnique
      // 1) enforceOwnership lookup
      .mockResolvedValueOnce(makeItinerary())
      // 2) createVersion lookup (after .update writes the new status)
      .mockResolvedValueOnce(makeItinerary({ status: 'published' }));
    prisma.itinerary.update.mockResolvedValue(makeItinerary({ status: 'published' }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      snapshot: {
        schemaVersion: 2,
        metadata: {
          id: 'itin-1',
          ownerId: 'user-1',
          title: 'Trip',
          destination: 'Paris',
          startDate: FIXED_START.toISOString(),
          endDate: new Date('2026-06-05T00:00:00.000Z').toISOString(),
          status: 'draft',
        },
        items: [],
      },
    });
    prisma.itineraryVersion.create.mockResolvedValue({ versionNumber: 2 });

    await itineraryService.updateItinerary('itin-1', 'user-1', 'admin', { status: 'published' });

    // Per the prompt, every save creates a versioned revision record —
    // including status-only lifecycle transitions.
    expect(prisma.itineraryVersion.create).toHaveBeenCalled();
    const call = prisma.itineraryVersion.create.mock.calls[0][0];
    expect(call.data.versionNumber).toBe(2);
    expect(call.data.snapshot.metadata.status).toBe('published');
    const metaChanges = call.data.diffMetadata.metadata as Array<{ field: string; from: unknown; to: unknown }>;
    expect(metaChanges.find((c) => c.field === 'status')).toEqual({
      field: 'status',
      from: 'draft',
      to: 'published',
    });
  });

  it('cuts a new version on a content (title) update', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.itinerary.update.mockResolvedValue(makeItinerary({ title: 'Renamed' }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    // Previous version snapshot has the new schemaVersion 2 shape so the diff
    // path can read prev.items / prev.metadata.
    prisma.itineraryVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      snapshot: {
        schemaVersion: 2,
        metadata: {
          id: 'itin-1',
          ownerId: 'user-1',
          title: 'Trip',
          destination: 'Paris',
          startDate: FIXED_START.toISOString(),
          endDate: new Date('2026-06-05T00:00:00.000Z').toISOString(),
          status: 'draft',
        },
        items: [],
      },
    });
    prisma.itineraryVersion.create.mockResolvedValue({ versionNumber: 2 });

    await itineraryService.updateItinerary('itin-1', 'user-1', 'admin', { title: 'Renamed' });

    expect(prisma.itineraryVersion.create).toHaveBeenCalled();
    const call = prisma.itineraryVersion.create.mock.calls[0][0];
    expect(call.data.versionNumber).toBe(2);
    // Snapshot now includes metadata + items, not just items.
    expect(call.data.snapshot.metadata).toBeDefined();
    expect(call.data.snapshot.items).toBeDefined();
  });
});

describe('itinerary.service.createVersion — diff metadata', () => {
  it('reports a metadata diff entry when title changes between versions', async () => {
    // Seed: existing version with old title
    const oldSnapshot = {
      schemaVersion: 2,
      metadata: {
        id: 'itin-1',
        ownerId: 'user-1',
        title: 'Old Title',
        destination: 'Paris',
        startDate: FIXED_START.toISOString(),
        endDate: new Date('2026-06-05T00:00:00.000Z').toISOString(),
        status: 'draft',
      },
      items: [],
    };
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary({ title: 'New Title' }));
    prisma.itinerary.update.mockResolvedValue(makeItinerary({ title: 'New Title' }));
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      snapshot: oldSnapshot,
    });
    prisma.itineraryVersion.create.mockResolvedValue({ versionNumber: 2 });

    await itineraryService.updateItinerary('itin-1', 'user-1', 'admin', { title: 'New Title' });

    const call = prisma.itineraryVersion.create.mock.calls[0][0];
    expect(call.data.diffMetadata).toBeDefined();
    const metaChanges = call.data.diffMetadata.metadata as Array<{ field: string; from: unknown; to: unknown }>;
    expect(metaChanges.find((c) => c.field === 'title')).toEqual({
      field: 'title',
      from: 'Old Title',
      to: 'New Title',
    });
  });

  it('reports an item-level added diff when a new item lands', async () => {
    const oldSnapshot = {
      schemaVersion: 2,
      metadata: {
        id: 'itin-1',
        ownerId: 'user-1',
        title: 'Trip',
        destination: 'Paris',
        startDate: FIXED_START.toISOString(),
        endDate: new Date('2026-06-05T00:00:00.000Z').toISOString(),
        status: 'draft',
      },
      items: [],
    };
    prisma.itinerary.findUnique.mockResolvedValue(makeItinerary());
    prisma.resource.findUnique.mockResolvedValue(makeResource());
    prisma.itineraryItem.findMany
      // 1st call: validateItem load existing items on day → none
      .mockResolvedValueOnce([])
      // 2nd call: createVersion fetching items for snapshot → contains the new item
      .mockResolvedValueOnce([
        {
          id: 'item-new',
          resourceId: 'res-1',
          dayNumber: 1,
          startTime: '14:00',
          endTime: '15:00',
          notes: null,
          position: 0,
        },
      ]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);
    prisma.itineraryItem.create.mockResolvedValue({
      id: 'item-new',
      itineraryId: 'itin-1',
      resourceId: 'res-1',
      dayNumber: 1,
      startTime: '14:00',
      endTime: '15:00',
      notes: null,
      position: 0,
      resource: makeResource(),
    });
    prisma.itineraryVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      snapshot: oldSnapshot,
    });
    prisma.itineraryVersion.create.mockResolvedValue({ versionNumber: 2 });

    await itineraryService.addItem('itin-1', 'user-1', 'admin', {
      resourceId: 'res-1',
      dayNumber: 1,
      startTime: '14:00',
      endTime: '15:00',
    });

    const call = prisma.itineraryVersion.create.mock.calls[0][0];
    expect(call.data.diffMetadata.items.added).toContain('item-new');
    expect(call.data.diffMetadata.items.removed).toEqual([]);
  });
});
