/**
 * Coverage for `src/services/routing.service.ts`.
 *
 * `optimizeItinerary` is the only public export; every other function in
 * the file is a private helper that the public function drives. So we
 * exercise the public entry point with fixtures that force each helper's
 * branches to run:
 *   - enforceItineraryOwnership 404 + 403 + admin-override
 *   - loadTravelTimes empty + populated
 *   - getTravelTime fallback (unknown pair → default 15)
 *   - clusterKey unknown city/region vs populated
 *   - nearestNeighbor on >1 items with asymmetric travel
 *   - generateArrangements single-item short-circuit AND multi-item path
 *   - deduplication of identical sequences
 */

import { optimizeItinerary } from '../src/services/routing.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'it-' + Math.random().toString(36).slice(2, 8),
    itineraryId: 'trip-1',
    resourceId: 'r-1',
    dayNumber: 1,
    startTime: '10:00',
    endTime: '11:00',
    notes: null,
    position: 0,
    resource: { id: 'r-1', name: 'Place', city: 'Rome', region: 'IT' },
    ...over,
  };
}

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

describe('optimizeItinerary — ownership enforcement', () => {
  it('throws 404 when itinerary not found', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(null);
    await expect(optimizeItinerary('missing', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 403 when non-admin tries to optimise someone else\'s trip', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'someone-else' });
    await expect(optimizeItinerary('t1', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admin bypass allows optimising another user\'s itinerary', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'someone-else' });
    // empty items → 404 but ownership passed (admin bypass)
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    await expect(optimizeItinerary('t1', 'admin-user', 'admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('optimizeItinerary — empty itinerary', () => {
  it('throws 404 when there are no items', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    await expect(optimizeItinerary('t1', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('optimizeItinerary — main path', () => {
  it('produces ranked candidate orderings for a single-item day', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([makeItem({ id: 'i1', position: 0 })]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0]).toMatchObject({ rank: 1, dayNumber: 1, totalTravelMinutes: 0 });
  });

  it('ranks multi-item day with travel times and exposes estimatedTimeSaved', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 'i1', resourceId: 'r-1', position: 0,
        resource: { id: 'r-1', name: 'A', city: 'Rome', region: 'IT' },
      }),
      makeItem({
        id: 'i2', resourceId: 'r-2', position: 1,
        resource: { id: 'r-2', name: 'B', city: 'Rome', region: 'IT' },
      }),
      makeItem({
        id: 'i3', resourceId: 'r-3', position: 2,
        resource: { id: 'r-3', name: 'C', city: 'Milan', region: 'IT' },
      }),
    ]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([
      { fromResourceId: 'r-1', toResourceId: 'r-2', travelMinutes: 5 },
      { fromResourceId: 'r-2', toResourceId: 'r-1', travelMinutes: 5 },
      { fromResourceId: 'r-1', toResourceId: 'r-3', travelMinutes: 100 },
      { fromResourceId: 'r-3', toResourceId: 'r-1', travelMinutes: 100 },
      { fromResourceId: 'r-2', toResourceId: 'r-3', travelMinutes: 90 },
      { fromResourceId: 'r-3', toResourceId: 'r-2', travelMinutes: 90 },
    ]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const s of suggestions) {
      expect(typeof s.totalTravelMinutes).toBe('number');
      expect(s.estimatedTimeSaved).toBeGreaterThanOrEqual(0);
      expect(typeof s.reason).toBe('string');
    }
  });

  it('filters by dayNumber when provided', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([makeItem({ id: 'i1' })]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    await optimizeItinerary('t1', 'u1', 'organizer', 2);
    expect(prisma.itineraryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ dayNumber: 2 }) }),
    );
  });

  it('uses "unknown" cluster key when resource.city/region are null', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 'i1', resourceId: 'r-1', position: 0,
        resource: { id: 'r-1', name: 'A', city: null, region: null },
      }),
      makeItem({
        id: 'i2', resourceId: 'r-2', position: 1,
        resource: { id: 'r-2', name: 'B', city: null, region: null },
      }),
    ]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    // Both items share cluster "unknown::unknown", travel pairs default to 15
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].reason).toContain('unknown');
  });

  it('groups items across multiple days', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 'a', dayNumber: 1 }),
      makeItem({ id: 'b', dayNumber: 1, resourceId: 'r-2', resource: { id: 'r-2', name: 'B', city: 'Rome', region: 'IT' } }),
      makeItem({ id: 'c', dayNumber: 2 }),
    ]);
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    const days = new Set(suggestions.map((s) => s.dayNumber));
    expect(days.has(1)).toBe(true);
    expect(days.has(2)).toBe(true);
  });
});
