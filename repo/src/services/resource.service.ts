import { getPrisma } from '../config/database';
import { AppError, NOT_FOUND, VALIDATION_ERROR, CONFLICT } from '../utils/errors';
import { RESOURCE_TYPES } from '../schemas/resource.schemas';

const ALLOWED_TYPES: readonly string[] = RESOURCE_TYPES;

/* ---------- Resource CRUD ---------- */

export async function createResource(data: {
  name: string;
  type: string;
  streetLine?: string;
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  minDwellMinutes?: number;
}) {
  const prisma = getPrisma();
  if (!ALLOWED_TYPES.includes(data.type)) {
    throw new AppError(400, VALIDATION_ERROR, `type must be one of: ${ALLOWED_TYPES.join(', ')}`);
  }

  return prisma.resource.create({
    data: {
      name: data.name,
      type: data.type,
      streetLine: data.streetLine,
      city: data.city,
      region: data.region,
      country: data.country,
      latitude: data.latitude,
      longitude: data.longitude,
      minDwellMinutes: data.minDwellMinutes ?? 30,
    },
  });
}

export async function listResources(filters: {
  type?: string;
  city?: string;
  page?: number;
  limit?: number;
}) {
  const prisma = getPrisma();
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (filters.type) where.type = filters.type;
  if (filters.city) where.city = filters.city;

  const [data, total] = await Promise.all([
    prisma.resource.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.resource.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function getResource(id: string) {
  const prisma = getPrisma();
  const resource = await prisma.resource.findUnique({
    where: { id },
    include: { hours: true, closures: true },
  });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');
  return resource;
}

export async function updateResource(id: string, data: Record<string, unknown>) {
  const prisma = getPrisma();

  const existing = await prisma.resource.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, NOT_FOUND, 'Resource not found');

  if (data.type) {
    if (!ALLOWED_TYPES.includes(data.type as string)) {
      throw new AppError(400, VALIDATION_ERROR, `type must be one of: ${ALLOWED_TYPES.join(', ')}`);
    }
  }

  return prisma.resource.update({ where: { id }, data });
}

export async function deleteResource(id: string) {
  const prisma = getPrisma();
  const existing = await prisma.resource.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, NOT_FOUND, 'Resource not found');

  await prisma.resource.delete({ where: { id } });
}

/* ---------- Business Hours ---------- */

export async function setBusinessHours(
  resourceId: string,
  data: { dayOfWeek: number; openTime: string; closeTime: string },
) {
  const prisma = getPrisma();

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');

  if (data.dayOfWeek < 0 || data.dayOfWeek > 6) {
    throw new AppError(400, VALIDATION_ERROR, 'dayOfWeek must be between 0 and 6');
  }

  return prisma.resourceHour.create({
    data: {
      resourceId,
      dayOfWeek: data.dayOfWeek,
      openTime: data.openTime,
      closeTime: data.closeTime,
    },
  });
}

export async function getBusinessHours(resourceId: string) {
  const prisma = getPrisma();

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');

  return prisma.resourceHour.findMany({
    where: { resourceId },
    orderBy: { dayOfWeek: 'asc' },
  });
}

/* ---------- Closures ---------- */

export async function addClosure(
  resourceId: string,
  data: { date: string | Date; reason?: string },
) {
  const prisma = getPrisma();

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');

  return prisma.resourceClosure.create({
    data: {
      resourceId,
      date: new Date(data.date),
      reason: data.reason,
    },
  });
}

export async function getClosures(resourceId: string) {
  const prisma = getPrisma();

  const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');

  return prisma.resourceClosure.findMany({
    where: { resourceId },
    orderBy: { date: 'asc' },
  });
}

/* ---------- Travel Time Matrix ---------- */

export async function upsertTravelTime(data: {
  fromResourceId: string;
  toResourceId: string;
  transportMode: string;
  travelMinutes: number;
}) {
  const prisma = getPrisma();

  // Validate both resources exist
  const [from, to] = await Promise.all([
    prisma.resource.findUnique({ where: { id: data.fromResourceId } }),
    prisma.resource.findUnique({ where: { id: data.toResourceId } }),
  ]);
  if (!from) throw new AppError(404, NOT_FOUND, 'Source resource not found');
  if (!to) throw new AppError(404, NOT_FOUND, 'Destination resource not found');

  return prisma.travelTimeMatrix.upsert({
    where: {
      fromResourceId_toResourceId_transportMode: {
        fromResourceId: data.fromResourceId,
        toResourceId: data.toResourceId,
        transportMode: data.transportMode,
      },
    },
    create: {
      fromResourceId: data.fromResourceId,
      toResourceId: data.toResourceId,
      transportMode: data.transportMode,
      travelMinutes: data.travelMinutes,
    },
    update: {
      travelMinutes: data.travelMinutes,
    },
  });
}

export async function listTravelTimes(fromResourceId?: string) {
  const prisma = getPrisma();
  const where: Record<string, unknown> = {};
  if (fromResourceId) where.fromResourceId = fromResourceId;

  return prisma.travelTimeMatrix.findMany({
    where,
    include: { fromResource: true, toResource: true },
    orderBy: { updatedAt: 'desc' },
  });
}
