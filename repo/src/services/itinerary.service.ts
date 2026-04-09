import { Prisma } from '../models/prisma';
import { getPrisma } from '../config/database';
import {
  AppError,
  NOT_FOUND,
  FORBIDDEN,
  CONFLICT,
  VALIDATION_ERROR,
} from '../utils/errors';

/* ---------- Helpers ---------- */

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

async function enforceOwnership(itineraryId: string, userId: string, role: string) {
  const prisma = getPrisma();
  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');
  if (role !== 'admin' && itinerary.ownerId !== userId) throw new AppError(403, FORBIDDEN, 'Access denied');
  return itinerary;
}

/**
 * Itinerary metadata fields that participate in version snapshots and diffs.
 *
 * `status` is intentionally NOT in this list — status-only updates are routine
 * lifecycle transitions (draft → published → archived) and shouldn't burn a
 * new version. The "should we cut a new version?" decision in updateItinerary
 * only triggers on these content fields.
 */
const VERSIONED_METADATA_FIELDS = ['title', 'destination', 'startDate', 'endDate'] as const;

interface ItineraryMetadataSnapshot {
  id: string;
  ownerId: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

interface ItineraryItemSnapshot {
  id: string;
  resourceId: string;
  dayNumber: number;
  startTime: string;
  endTime: string;
  notes: string | null;
  position: number;
}

interface ItinerarySnapshot {
  schemaVersion: number;
  metadata: ItineraryMetadataSnapshot;
  items: ItineraryItemSnapshot[];
}

interface MetadataDiff {
  field: string;
  from: unknown;
  to: unknown;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function buildItemSnapshot(item: {
  id: string;
  resourceId: string;
  dayNumber: number;
  startTime: string;
  endTime: string;
  notes: string | null;
  position: number;
}): ItineraryItemSnapshot {
  return {
    id: item.id,
    resourceId: item.resourceId,
    dayNumber: item.dayNumber,
    startTime: item.startTime,
    endTime: item.endTime,
    notes: item.notes,
    position: item.position,
  };
}

async function createVersion(itineraryId: string, userId: string) {
  const prisma = getPrisma();

  // Capture both itinerary metadata AND items in the snapshot. Earlier the
  // snapshot was an items-only array, which meant a renamed itinerary or
  // shifted travel dates left no recoverable history.
  const itinerary = await prisma.itinerary.findUnique({
    where: { id: itineraryId },
  });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');

  const items = await prisma.itineraryItem.findMany({
    where: { itineraryId },
    orderBy: [{ dayNumber: 'asc' }, { startTime: 'asc' }],
  });

  const snapshot: ItinerarySnapshot = {
    schemaVersion: 2,
    metadata: {
      id: itinerary.id,
      ownerId: itinerary.ownerId,
      title: itinerary.title,
      destination: itinerary.destination ?? null,
      startDate: isoOrNull(itinerary.startDate),
      endDate: isoOrNull(itinerary.endDate),
      status: itinerary.status,
    },
    items: items.map(buildItemSnapshot),
  };

  // Determine next version number
  const lastVersion = await prisma.itineraryVersion.findFirst({
    where: { itineraryId },
    orderBy: { versionNumber: 'desc' },
  });
  const nextNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  // Compute diff from previous version. Diff covers BOTH metadata and items
  // so consumers can render a full change log without diffing the snapshots
  // themselves.
  let diffMetadata: Record<string, unknown> | null = null;
  if (lastVersion) {
    const rawPrev = lastVersion.snapshot as unknown;

    // Snapshots written before schemaVersion 2 were a bare items array. Wrap
    // legacy rows so the diff computation can treat them uniformly.
    let prev: ItinerarySnapshot;
    if (Array.isArray(rawPrev)) {
      prev = {
        schemaVersion: 1,
        metadata: snapshot.metadata, // unknown; assume no metadata change
        items: rawPrev as unknown as ItineraryItemSnapshot[],
      };
    } else {
      prev = rawPrev as ItinerarySnapshot;
    }

    // Item-level diff
    const currentIds = new Set(items.map((i) => i.id));
    const prevItems = prev.items ?? [];
    const prevIds = new Set(prevItems.map((i) => i.id));
    const added = items.filter((i) => !prevIds.has(i.id)).map((i) => i.id);
    const removed = prevItems.filter((i) => !currentIds.has(i.id)).map((i) => i.id);
    const modified = items
      .filter((i) => prevIds.has(i.id))
      .filter((cur) => {
        const previous = prevItems.find((p) => p.id === cur.id);
        if (!previous) return false;
        return (
          previous.startTime !== cur.startTime ||
          previous.endTime !== cur.endTime ||
          previous.dayNumber !== cur.dayNumber ||
          previous.resourceId !== cur.resourceId ||
          previous.notes !== cur.notes ||
          previous.position !== cur.position
        );
      })
      .map((i) => i.id);

    // Metadata-level diff. Only the versioned fields participate — status is
    // tracked in snapshot but not in the diff so a status-only PATCH is a no-op.
    const metadataChanges: MetadataDiff[] = [];
    if (prev.schemaVersion >= 2) {
      for (const field of VERSIONED_METADATA_FIELDS) {
        const before = (prev.metadata as Record<string, unknown>)[field];
        const after = (snapshot.metadata as Record<string, unknown>)[field];
        if (before !== after) {
          metadataChanges.push({ field, from: before ?? null, to: after ?? null });
        }
      }
    }

    diffMetadata = {
      items: { added, removed, modified },
      metadata: metadataChanges,
    };
  }

  return prisma.itineraryVersion.create({
    data: {
      itineraryId,
      versionNumber: nextNumber,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
      diffMetadata: (diffMetadata as Prisma.InputJsonValue) ?? undefined,
      createdBy: userId,
    },
  });
}

async function validateItem(
  itineraryId: string,
  dayNumber: number,
  startTime: string,
  endTime: string,
  resourceId: string,
  excludeItemId?: string,
) {
  const prisma = getPrisma();
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  if (startMin >= endMin) {
    throw new AppError(400, VALIDATION_ERROR, 'startTime must be before endTime');
  }

  // Load resource with hours and closures
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: { hours: true, closures: true },
  });
  if (!resource) throw new AppError(404, NOT_FOUND, 'Resource not found');

  // 1. Min dwell time check
  const durationMinutes = endMin - startMin;
  if (durationMinutes < resource.minDwellMinutes) {
    throw new AppError(
      400,
      VALIDATION_ERROR,
      `Duration (${durationMinutes}min) is less than minimum dwell time (${resource.minDwellMinutes}min)`,
    );
  }

  // 2. Closure date check — need itinerary start date to compute actual date
  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');

  if (itinerary.startDate) {
    const actualDate = new Date(itinerary.startDate);
    actualDate.setDate(actualDate.getDate() + (dayNumber - 1));
    // Normalize to date-only for comparison
    const dateStr = actualDate.toISOString().split('T')[0];

    const closure = resource.closures.find((c) => {
      const closureStr = new Date(c.date).toISOString().split('T')[0];
      return closureStr === dateStr;
    });
    if (closure) {
      throw new AppError(
        400,
        VALIDATION_ERROR,
        `Resource is closed on this date${closure.reason ? ': ' + closure.reason : ''}`,
      );
    }

    // 3. Business hours check
    const dayOfWeek = actualDate.getDay();
    const hoursForDay = resource.hours.filter((h) => h.dayOfWeek === dayOfWeek);
    if (hoursForDay.length > 0) {
      const withinAnyWindow = hoursForDay.some((h) => {
        const openMin = timeToMinutes(h.openTime);
        const closeMin = timeToMinutes(h.closeTime);
        return startMin >= openMin && endMin <= closeMin;
      });
      if (!withinAnyWindow) {
        throw new AppError(400, VALIDATION_ERROR, 'Item time falls outside business hours');
      }
    }
  }

  // 4. Load existing items on same day for overlap / buffer / travel checks
  const existingItems = await prisma.itineraryItem.findMany({
    where: {
      itineraryId,
      dayNumber,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
    },
    include: { resource: true },
    orderBy: { startTime: 'asc' },
  });

  const BUFFER_MINUTES = 15;

  for (const item of existingItems) {
    const existStart = timeToMinutes(item.startTime);
    const existEnd = timeToMinutes(item.endTime);

    // 5. Overlap detection
    if (startMin < existEnd && endMin > existStart) {
      throw new AppError(409, CONFLICT, 'Time slot overlaps with an existing item');
    }

    // 6. 15-minute buffer
    if (
      (startMin >= existEnd && startMin < existEnd + BUFFER_MINUTES) ||
      (endMin > existStart - BUFFER_MINUTES && endMin <= existStart)
    ) {
      throw new AppError(409, CONFLICT, 'Items must have at least a 15-minute buffer between them');
    }
  }

  // 7. Travel time from previous item
  // Find the item that ends right before our start
  const previousItem = existingItems
    .filter((i) => timeToMinutes(i.endTime) <= startMin)
    .sort((a, b) => timeToMinutes(b.endTime) - timeToMinutes(a.endTime))[0];

  if (previousItem) {
    const travelTime = await prisma.travelTimeMatrix.findFirst({
      where: {
        fromResourceId: previousItem.resourceId,
        toResourceId: resourceId,
      },
    });

    if (travelTime) {
      const prevEnd = timeToMinutes(previousItem.endTime);
      const gap = startMin - prevEnd;
      if (gap < travelTime.travelMinutes) {
        throw new AppError(
          409,
          CONFLICT,
          `Insufficient travel time from previous item (need ${travelTime.travelMinutes}min, have ${gap}min)`,
        );
      }
    }
  }
}

/* ---------- Itinerary CRUD ---------- */

export async function createItinerary(
  ownerId: string,
  data: { title: string; destination?: string; startDate?: string | Date; endDate?: string | Date },
) {
  const prisma = getPrisma();
  const itinerary = await prisma.itinerary.create({
    data: {
      ownerId,
      title: data.title,
      destination: data.destination,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate ? new Date(data.endDate) : undefined,
    },
  });
  // Initial save = version 1. Captures the empty-items snapshot at creation
  // time so the version history is well-defined from the very first read.
  await createVersion(itinerary.id, ownerId);
  return itinerary;
}

export async function listItineraries(
  userId: string,
  role: string,
  filters: { status?: string; page?: number; limit?: number },
) {
  const prisma = getPrisma();
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (role !== 'admin') {
    where.ownerId = userId;
  }
  if (filters.status) where.status = filters.status;

  const [data, total] = await Promise.all([
    prisma.itinerary.findMany({ where, skip, take: limit, orderBy: { updatedAt: 'desc' } }),
    prisma.itinerary.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function getItinerary(id: string, userId: string, role: string) {
  const prisma = getPrisma();
  const itinerary = await prisma.itinerary.findUnique({
    where: { id },
    include: {
      items: {
        include: { resource: true },
        orderBy: [{ dayNumber: 'asc' }, { startTime: 'asc' }],
      },
    },
  });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');
  if (role !== 'admin' && itinerary.ownerId !== userId) {
    throw new AppError(403, FORBIDDEN, 'Access denied');
  }
  return itinerary;
}

export async function updateItinerary(
  id: string,
  userId: string,
  role: string,
  data: Record<string, unknown>,
) {
  const itinerary = await enforceOwnership(id, userId, role);
  const prisma = getPrisma();

  // Determine if this is a content change (not just status)
  const contentFields = ['title', 'destination', 'startDate', 'endDate'];
  const isContentChange = contentFields.some((f) => f in data);

  // Normalize date fields
  const updateData: Record<string, unknown> = { ...data };
  if (updateData.startDate) updateData.startDate = new Date(updateData.startDate as string);
  if (updateData.endDate) updateData.endDate = new Date(updateData.endDate as string);

  const updated = await prisma.itinerary.update({ where: { id }, data: updateData });

  if (isContentChange) {
    await createVersion(id, userId);
  }

  return updated;
}

export async function deleteItinerary(id: string, userId: string, role: string) {
  await enforceOwnership(id, userId, role);
  const prisma = getPrisma();
  await prisma.itinerary.delete({ where: { id } });
}

/* ---------- Itinerary Items ---------- */

export async function addItem(
  itineraryId: string,
  userId: string,
  role: string,
  data: {
    resourceId: string;
    dayNumber: number;
    startTime: string;
    endTime: string;
    notes?: string;
    position?: number;
  },
) {
  await enforceOwnership(itineraryId, userId, role);

  await validateItem(itineraryId, data.dayNumber, data.startTime, data.endTime, data.resourceId);

  const prisma = getPrisma();
  const item = await prisma.itineraryItem.create({
    data: {
      itineraryId,
      resourceId: data.resourceId,
      dayNumber: data.dayNumber,
      startTime: data.startTime,
      endTime: data.endTime,
      notes: data.notes,
      position: data.position ?? 0,
    },
    include: { resource: true },
  });

  await createVersion(itineraryId, userId);
  return item;
}

export async function updateItem(
  itineraryId: string,
  itemId: string,
  userId: string,
  role: string,
  data: {
    resourceId?: string;
    dayNumber?: number;
    startTime?: string;
    endTime?: string;
    notes?: string;
    position?: number;
  },
) {
  await enforceOwnership(itineraryId, userId, role);

  const prisma = getPrisma();
  const existing = await prisma.itineraryItem.findFirst({
    where: { id: itemId, itineraryId },
  });
  if (!existing) throw new AppError(404, NOT_FOUND, 'Itinerary item not found');

  const merged = {
    resourceId: data.resourceId ?? existing.resourceId,
    dayNumber: data.dayNumber ?? existing.dayNumber,
    startTime: data.startTime ?? existing.startTime,
    endTime: data.endTime ?? existing.endTime,
  };

  await validateItem(
    itineraryId,
    merged.dayNumber,
    merged.startTime,
    merged.endTime,
    merged.resourceId,
    itemId,
  );

  const updated = await prisma.itineraryItem.update({
    where: { id: itemId },
    data: {
      resourceId: merged.resourceId,
      dayNumber: merged.dayNumber,
      startTime: merged.startTime,
      endTime: merged.endTime,
      notes: data.notes !== undefined ? data.notes : undefined,
      position: data.position !== undefined ? data.position : undefined,
    },
    include: { resource: true },
  });

  await createVersion(itineraryId, userId);
  return updated;
}

export async function removeItem(
  itineraryId: string,
  itemId: string,
  userId: string,
  role: string,
) {
  await enforceOwnership(itineraryId, userId, role);

  const prisma = getPrisma();
  const existing = await prisma.itineraryItem.findFirst({
    where: { id: itemId, itineraryId },
  });
  if (!existing) throw new AppError(404, NOT_FOUND, 'Itinerary item not found');

  await prisma.itineraryItem.delete({ where: { id: itemId } });
  await createVersion(itineraryId, userId);
}

export async function listItems(
  itineraryId: string,
  userId: string,
  role: string,
  dayNumber?: number,
) {
  await enforceOwnership(itineraryId, userId, role);

  const prisma = getPrisma();
  const where: Record<string, unknown> = { itineraryId };
  if (dayNumber !== undefined) where.dayNumber = dayNumber;

  return prisma.itineraryItem.findMany({
    where,
    include: { resource: true },
    orderBy: [{ dayNumber: 'asc' }, { startTime: 'asc' }],
  });
}

/* ---------- Versions ---------- */

export async function getVersions(itineraryId: string, userId: string, role: string) {
  await enforceOwnership(itineraryId, userId, role);

  const prisma = getPrisma();
  return prisma.itineraryVersion.findMany({
    where: { itineraryId },
    orderBy: { versionNumber: 'desc' },
  });
}
