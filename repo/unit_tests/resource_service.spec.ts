/**
 * Coverage for `src/services/resource.service.ts`. Each exported function
 * is exercised for its success path AND its documented error branches
 * (404 not found, 400 bad type, 400 bad dayOfWeek).
 */

import * as svc from '../src/services/resource.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

beforeEach(() => {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

describe('createResource', () => {
  it('rejects unknown type with 400', async () => {
    await expect(svc.createResource({ name: 'X', type: 'not-real' })).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.resource.create).not.toHaveBeenCalled();
  });

  it('creates with defaults for minDwellMinutes when omitted', async () => {
    prisma.resource.create.mockResolvedValue({ id: 'r1' });
    await svc.createResource({ name: 'Colosseum', type: 'attraction' });
    const data = prisma.resource.create.mock.calls[0][0].data;
    expect(data.minDwellMinutes).toBe(30);
    expect(data.name).toBe('Colosseum');
  });

  it('preserves overridden minDwellMinutes', async () => {
    prisma.resource.create.mockResolvedValue({ id: 'r1' });
    await svc.createResource({ name: 'X', type: 'attraction', minDwellMinutes: 90 });
    expect(prisma.resource.create.mock.calls[0][0].data.minDwellMinutes).toBe(90);
  });
});

describe('listResources', () => {
  it('applies filters and pagination', async () => {
    prisma.resource.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.resource.count.mockResolvedValue(1);
    const out = await svc.listResources({ type: 'attraction', city: 'Rome', page: 2, limit: 5 });
    expect(out).toEqual({ data: [{ id: 'r1' }], total: 1, page: 2, limit: 5 });
    const call = prisma.resource.findMany.mock.calls[0][0];
    expect(call.skip).toBe(5);
    expect(call.take).toBe(5);
    expect(call.where).toEqual({ type: 'attraction', city: 'Rome' });
  });

  it('defaults to page 1, limit 20, empty where', async () => {
    prisma.resource.findMany.mockResolvedValue([]);
    prisma.resource.count.mockResolvedValue(0);
    const out = await svc.listResources({});
    expect(out.page).toBe(1);
    expect(out.limit).toBe(20);
    const call = prisma.resource.findMany.mock.calls[0][0];
    expect(call.where).toEqual({});
  });
});

describe('getResource', () => {
  it('404 when missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.getResource('rX')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns with hours+closures', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1', hours: [], closures: [] });
    const out = await svc.getResource('r1');
    expect(out.id).toBe('r1');
  });
});

describe('updateResource', () => {
  it('404 when missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.updateResource('rX', { name: 'Y' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when bad type supplied', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    await expect(svc.updateResource('r1', { type: 'bogus' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts update without type change', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resource.update.mockResolvedValue({ id: 'r1', name: 'Y' });
    const out = await svc.updateResource('r1', { name: 'Y' });
    expect(out.name).toBe('Y');
  });

  it('accepts valid type change', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resource.update.mockResolvedValue({ id: 'r1', type: 'lodging' });
    const out = await svc.updateResource('r1', { type: 'lodging' });
    expect(out.type).toBe('lodging');
  });
});

describe('deleteResource', () => {
  it('404 when missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.deleteResource('rX')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes when present', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resource.delete.mockResolvedValue({ id: 'r1' });
    await svc.deleteResource('r1');
    expect(prisma.resource.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });
});

describe('business hours', () => {
  it('setBusinessHours 404 when resource missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(
      svc.setBusinessHours('rX', { dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('setBusinessHours rejects day < 0', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    await expect(
      svc.setBusinessHours('r1', { dayOfWeek: -1, openTime: '09:00', closeTime: '17:00' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('setBusinessHours rejects day > 6', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    await expect(
      svc.setBusinessHours('r1', { dayOfWeek: 7, openTime: '09:00', closeTime: '17:00' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('setBusinessHours success', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resourceHour.create.mockResolvedValue({ id: 'h1', dayOfWeek: 3 });
    const out = await svc.setBusinessHours('r1', { dayOfWeek: 3, openTime: '09:00', closeTime: '17:00' });
    expect(out.dayOfWeek).toBe(3);
  });

  it('getBusinessHours 404 when resource missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.getBusinessHours('rX')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getBusinessHours returns ordered list', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resourceHour.findMany.mockResolvedValue([]);
    await svc.getBusinessHours('r1');
    expect(prisma.resourceHour.findMany).toHaveBeenCalledWith({
      where: { resourceId: 'r1' },
      orderBy: { dayOfWeek: 'asc' },
    });
  });
});

describe('closures', () => {
  it('addClosure 404 when resource missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.addClosure('rX', { date: '2026-04-01' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('addClosure converts string date and stores reason', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resourceClosure.create.mockResolvedValue({ id: 'c1' });
    await svc.addClosure('r1', { date: '2026-04-01', reason: 'holiday' });
    const data = prisma.resourceClosure.create.mock.calls[0][0].data;
    expect(data.date).toBeInstanceOf(Date);
    expect(data.reason).toBe('holiday');
  });

  it('addClosure without reason', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resourceClosure.create.mockResolvedValue({ id: 'c1' });
    await svc.addClosure('r1', { date: new Date('2026-05-01') });
    const data = prisma.resourceClosure.create.mock.calls[0][0].data;
    expect(data.reason).toBeUndefined();
  });

  it('getClosures 404 when resource missing', async () => {
    prisma.resource.findUnique.mockResolvedValue(null);
    await expect(svc.getClosures('rX')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getClosures returns ordered list', async () => {
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1' });
    prisma.resourceClosure.findMany.mockResolvedValue([]);
    await svc.getClosures('r1');
    expect(prisma.resourceClosure.findMany).toHaveBeenCalledWith({
      where: { resourceId: 'r1' },
      orderBy: { date: 'asc' },
    });
  });
});

describe('travel time matrix', () => {
  it('upsertTravelTime 404 when source missing', async () => {
    prisma.resource.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r2' });
    await expect(
      svc.upsertTravelTime({ fromResourceId: 'a', toResourceId: 'b', transportMode: 'car', travelMinutes: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, message: /Source/ });
  });

  it('upsertTravelTime 404 when dest missing', async () => {
    prisma.resource.findUnique.mockResolvedValueOnce({ id: 'r1' }).mockResolvedValueOnce(null);
    await expect(
      svc.upsertTravelTime({ fromResourceId: 'a', toResourceId: 'b', transportMode: 'car', travelMinutes: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, message: /Destination/ });
  });

  it('upsertTravelTime upserts using compound key', async () => {
    prisma.resource.findUnique.mockResolvedValueOnce({ id: 'r1' }).mockResolvedValueOnce({ id: 'r2' });
    prisma.travelTimeMatrix.upsert.mockResolvedValue({ id: 't1' });
    await svc.upsertTravelTime({ fromResourceId: 'r1', toResourceId: 'r2', transportMode: 'car', travelMinutes: 15 });
    const call = prisma.travelTimeMatrix.upsert.mock.calls[0][0];
    expect(call.where.fromResourceId_toResourceId_transportMode).toEqual({
      fromResourceId: 'r1',
      toResourceId: 'r2',
      transportMode: 'car',
    });
    expect(call.create.travelMinutes).toBe(15);
    expect(call.update.travelMinutes).toBe(15);
  });

  it('listTravelTimes applies from filter and orderBy', async () => {
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    await svc.listTravelTimes('r1');
    const call = prisma.travelTimeMatrix.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ fromResourceId: 'r1' });
    expect(call.orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('listTravelTimes without filter', async () => {
    prisma.travelTimeMatrix.findMany.mockResolvedValue([]);
    await svc.listTravelTimes();
    expect(prisma.travelTimeMatrix.findMany.mock.calls[0][0].where).toEqual({});
  });
});
