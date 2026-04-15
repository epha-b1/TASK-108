/**
 * Coverage for the `validateItem` private paths + CRUD branches in
 * `src/services/itinerary.service.ts` that aren't exercised by the
 * existing itinerary.spec.ts.
 */

import * as svc from '../src/services/itinerary.service';
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

beforeEach(() => {
  resetPrisma();
});

function itinerary(over: Partial<any> = {}) {
  return { id: 't1', ownerId: 'u1', title: 'Trip', startDate: null, endDate: null, status: 'draft', destination: null, ...over };
}
function resource(over: Partial<any> = {}) {
  return { id: 'r1', minDwellMinutes: 30, hours: [], closures: [], ...over };
}

describe('createItinerary', () => {
  it('creates v1 version with empty snapshot', async () => {
    prisma.itinerary.create.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itinerary.findUnique.mockResolvedValue(itinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({ id: 'v1' });
    const out = await svc.createItinerary('u1', { title: 'Trip' });
    expect(out.id).toBe('t1');
    const verData = prisma.itineraryVersion.create.mock.calls[0][0].data;
    expect(verData.versionNumber).toBe(1);
  });

  it('passes through string date fields', async () => {
    prisma.itinerary.create.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itinerary.findUnique.mockResolvedValue(itinerary());
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({ id: 'v1' });
    await svc.createItinerary('u1', { title: 'Trip', startDate: '2026-06-01', endDate: new Date('2026-06-07') });
    const args = prisma.itinerary.create.mock.calls[0][0].data;
    expect(args.startDate).toBeInstanceOf(Date);
    expect(args.endDate).toBeInstanceOf(Date);
  });
});

describe('listItineraries', () => {
  it('admin sees all owners', async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);
    prisma.itinerary.count.mockResolvedValue(0);
    await svc.listItineraries('u1', 'admin', {});
    const where = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(where.ownerId).toBeUndefined();
  });

  it('organizer sees only own itineraries', async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);
    prisma.itinerary.count.mockResolvedValue(0);
    await svc.listItineraries('u1', 'organizer', { status: 'published', page: 2, limit: 5 });
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ ownerId: 'u1', status: 'published' });
    expect(call.skip).toBe(5);
  });
});

describe('getItinerary', () => {
  it('404 missing', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(null);
    await expect(svc.getItinerary('t1', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when organizer not owner', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'other', items: [] });
    await expect(svc.getItinerary('t1', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admin can get any', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'other', items: [] });
    const out = await svc.getItinerary('t1', 'uA', 'admin');
    expect(out.id).toBe('t1');
  });
});

describe('updateItinerary', () => {
  it('updates, normalises dates, and cuts a version', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // ownership
      .mockResolvedValueOnce(itinerary({ status: 'draft' })); // version snapshot
    prisma.itinerary.update.mockResolvedValue({ id: 't1', status: 'published' });
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({ id: 'v2' });
    await svc.updateItinerary('t1', 'u1', 'organizer', {
      status: 'published', startDate: '2026-06-01', endDate: '2026-06-07',
    });
    const data = prisma.itinerary.update.mock.calls[0][0].data;
    expect(data.startDate).toBeInstanceOf(Date);
  });

  it('forbidden when non-admin non-owner', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'other' });
    await expect(svc.updateItinerary('t1', 'u1', 'organizer', { title: 'X' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('deleteItinerary', () => {
  it('deletes after ownership passes', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itinerary.delete.mockResolvedValue({});
    await svc.deleteItinerary('t1', 'u1', 'organizer');
    expect(prisma.itinerary.delete).toHaveBeenCalled();
  });
});

describe('addItem — validateItem edge cases', () => {
  it('400 when startTime >= endTime', async () => {
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 't1', ownerId: 'u1' });
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '10:00',
    })).rejects.toMatchObject({ statusCode: 400, message: /before/ });
  });

  it('404 when resource not found', async () => {
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 't1', ownerId: 'u1' });
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'rX', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when duration below minDwell', async () => {
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 't1', ownerId: 'u1' });
    prisma.resource.findUnique.mockResolvedValue(resource({ minDwellMinutes: 60 }));
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '10:15',
    })).rejects.toMatchObject({ statusCode: 400, message: /dwell/ });
  });

  it('400 when itinerary missing during inner fetch', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // enforceOwnership
      .mockResolvedValueOnce(null); // validateItem inner call
    prisma.resource.findUnique.mockResolvedValue(resource());
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 on closure match', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary({ startDate: new Date('2026-06-01') }));
    prisma.resource.findUnique.mockResolvedValue(resource({
      closures: [{ date: new Date('2026-06-01'), reason: 'holiday' }],
    }));
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 400, message: /closed/ });
  });

  it('400 when outside business hours', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary({ startDate: new Date('2026-06-01') }));
    prisma.resource.findUnique.mockResolvedValue(resource({
      hours: [{ dayOfWeek: new Date('2026-06-01').getDay(), openTime: '09:00', closeTime: '10:00' }],
    }));
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '11:00', endTime: '12:00',
    })).rejects.toMatchObject({ statusCode: 400, message: /business hours/ });
  });

  it('409 on overlap with existing item', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary());
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'e1', dayNumber: 1, startTime: '10:30', endTime: '11:30', resourceId: 'r1' },
    ]);
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '11:00', endTime: '12:00',
    })).rejects.toMatchObject({ statusCode: 409, message: /overlap/ });
  });

  it('409 on buffer violation', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary());
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'e1', dayNumber: 1, startTime: '09:00', endTime: '10:00', resourceId: 'r2' },
    ]);
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:05', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 409, message: /buffer/ });
  });

  it('409 on insufficient travel time from previous', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary());
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'e1', dayNumber: 1, startTime: '09:00', endTime: '10:00', resourceId: 'r2' },
    ]);
    prisma.travelTimeMatrix.findFirst
      .mockResolvedValueOnce({ travelMinutes: 30 });
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:20', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 409, message: /travel time from previous/ });
  });

  it('409 on insufficient travel time to next', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary());
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'e2', dayNumber: 1, startTime: '11:30', endTime: '12:30', resourceId: 'r3' },
    ]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValueOnce({ travelMinutes: 60 });
    await expect(svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    })).rejects.toMatchObject({ statusCode: 409, message: /travel time to next/ });
  });

  it('happy path creates item, includes resource, cuts version', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' })
      .mockResolvedValueOnce(itinerary())
      // for createVersion
      .mockResolvedValueOnce(itinerary());
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([]) // validateItem same-day
      .mockResolvedValueOnce([]); // createVersion items
    prisma.itineraryItem.create.mockResolvedValue({ id: 'it1', resourceId: 'r1', dayNumber: 1, resource: {} });
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({});
    const out: any = await svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    });
    expect(out.id).toBe('it1');
  });
});

describe('updateItem', () => {
  it('404 when item does not belong to the itinerary', async () => {
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findFirst.mockResolvedValue(null);
    await expect(svc.updateItem('t1', 'iX', 'u1', 'organizer', { notes: 'n' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates item and cuts a version', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // ownership
      .mockResolvedValueOnce(itinerary())                  // validateItem inner
      .mockResolvedValueOnce(itinerary());                 // createVersion
    prisma.itineraryItem.findFirst.mockResolvedValue({
      id: 'it1', resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    });
    prisma.resource.findUnique.mockResolvedValue(resource());
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.itineraryItem.update.mockResolvedValue({ id: 'it1', resource: {} });
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({});
    const out: any = await svc.updateItem('t1', 'it1', 'u1', 'organizer', { startTime: '10:30' });
    expect(out.id).toBe('it1');
  });
});

describe('removeItem', () => {
  it('404 when item missing', async () => {
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findFirst.mockResolvedValue(null);
    await expect(svc.removeItem('t1', 'iX', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes and cuts version', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // ownership
      .mockResolvedValueOnce(itinerary());                 // createVersion
    prisma.itineraryItem.findFirst.mockResolvedValue({ id: 'it1' });
    prisma.itineraryItem.delete.mockResolvedValue({});
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({});
    await svc.removeItem('t1', 'it1', 'u1', 'organizer');
    expect(prisma.itineraryItem.delete).toHaveBeenCalledWith({ where: { id: 'it1' } });
  });
});

describe('listItems + getVersions', () => {
  it('listItems filters by dayNumber', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    await svc.listItems('t1', 'u1', 'organizer', 2);
    const where = prisma.itineraryItem.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ itineraryId: 't1', dayNumber: 2 });
  });

  it('listItems without dayNumber', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([]);
    await svc.listItems('t1', 'u1', 'organizer');
    const where = prisma.itineraryItem.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ itineraryId: 't1' });
  });

  it('getVersions returns versions desc', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryVersion.findMany.mockResolvedValue([]);
    await svc.getVersions('t1', 'u1', 'organizer');
    expect(prisma.itineraryVersion.findMany.mock.calls[0][0].orderBy).toEqual({ versionNumber: 'desc' });
  });
});

describe('createVersion — legacy snapshot compatibility', () => {
  it('handles legacy items-only array snapshot when computing diff', async () => {
    // Exercise the branch where a previous version is a bare array (schemaVersion 1).
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // ownership
      .mockResolvedValueOnce(itinerary());                 // createVersion inner
    prisma.itinerary.update.mockResolvedValue({});
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'i-current', resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00', notes: null, position: 0 },
    ]);
    // Legacy bare array with an item that's been removed AND a modified match.
    prisma.itineraryVersion.findFirst.mockResolvedValue({
      versionNumber: 1,
      snapshot: [
        { id: 'i-current', resourceId: 'r1', dayNumber: 1, startTime: '09:00', endTime: '10:00', notes: null, position: 0 },
        { id: 'i-removed', resourceId: 'r2', dayNumber: 1, startTime: '11:00', endTime: '12:00', notes: null, position: 1 },
      ],
    });
    prisma.itineraryVersion.create.mockResolvedValue({ id: 'v2' });
    await svc.updateItinerary('t1', 'u1', 'organizer', { title: 'Changed' });
    const data = prisma.itineraryVersion.create.mock.calls[0][0].data;
    expect(data.diffMetadata).toBeDefined();
    expect(data.versionNumber).toBe(2);
  });
});
