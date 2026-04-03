import { getPrisma } from '../config/database';
import {
  AppError,
  NOT_FOUND,
  FORBIDDEN,
} from '../utils/errors';

/* ---------- Types ---------- */

interface RoutingSuggestionItem {
  id: string;
  resourceId: string;
  dayNumber: number;
  startTime: string;
  endTime: string;
  notes: string | null;
  position: number;
  resource: {
    id: string;
    name: string;
    city: string | null;
    region: string | null;
  };
}

interface RoutingSuggestion {
  rank: number;
  dayNumber: number;
  items: RoutingSuggestionItem[];
  totalTravelMinutes: number;
  estimatedTimeSaved: number;
  reason: string;
}

/* ---------- Helpers ---------- */

async function enforceItineraryOwnership(itineraryId: string, userId: string, role: string) {
  const prisma = getPrisma();
  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');
  if (role !== 'admin' && itinerary.ownerId !== userId) {
    throw new AppError(403, FORBIDDEN, 'Access denied');
  }
  return itinerary;
}

function clusterKey(resource: { city: string | null; region: string | null }): string {
  return `${resource.city ?? 'unknown'}::${resource.region ?? 'unknown'}`;
}

/**
 * Build a lookup of travel times between resources keyed as "fromId->toId".
 */
async function loadTravelTimes(resourceIds: string[]): Promise<Map<string, number>> {
  const prisma = getPrisma();
  if (resourceIds.length === 0) return new Map();

  const rows = await prisma.travelTimeMatrix.findMany({
    where: {
      fromResourceId: { in: resourceIds },
      toResourceId: { in: resourceIds },
    },
  });

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.fromResourceId}->${r.toResourceId}`, r.travelMinutes);
  }
  return map;
}

function getTravelTime(map: Map<string, number>, fromId: string, toId: string): number {
  return map.get(`${fromId}->${toId}`) ?? 15; // default 15 min if unknown
}

/**
 * Compute total travel time for a sequence of resource IDs.
 */
function totalTravel(sequence: string[], travelMap: Map<string, number>): number {
  let total = 0;
  for (let i = 0; i < sequence.length - 1; i++) {
    total += getTravelTime(travelMap, sequence[i], sequence[i + 1]);
  }
  return total;
}

/**
 * Nearest-neighbor heuristic starting from a given index.
 * Returns ordered indices.
 */
function nearestNeighbor(
  items: { resourceId: string }[],
  travelMap: Map<string, number>,
  startIdx: number,
): number[] {
  const visited = new Set<number>();
  const order: number[] = [];
  let current = startIdx;
  visited.add(current);
  order.push(current);

  while (order.length < items.length) {
    let bestIdx = -1;
    let bestTime = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (visited.has(i)) continue;
      const t = getTravelTime(travelMap, items[current].resourceId, items[i].resourceId);
      if (t < bestTime) {
        bestTime = t;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    visited.add(bestIdx);
    order.push(bestIdx);
    current = bestIdx;
  }
  return order;
}

/**
 * Generate permutation-based suggestions for small clusters, or
 * nearest-neighbor from each starting point for larger ones.
 */
function generateArrangements(
  items: RoutingSuggestionItem[],
  travelMap: Map<string, number>,
): { order: number[]; travel: number }[] {
  if (items.length <= 1) {
    return [{ order: [0], travel: 0 }];
  }

  const arrangements: { order: number[]; travel: number }[] = [];

  // Try nearest-neighbor from each starting point
  for (let start = 0; start < items.length; start++) {
    const order = nearestNeighbor(items, travelMap, start);
    const ids = order.map((i) => items[i].resourceId);
    const travel = totalTravel(ids, travelMap);
    arrangements.push({ order, travel });
  }

  // Deduplicate by travel time and order
  const seen = new Set<string>();
  return arrangements.filter((a) => {
    const key = a.order.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reorderItems(
  items: RoutingSuggestionItem[],
  order: number[],
): RoutingSuggestionItem[] {
  return order.map((idx, pos) => ({
    ...items[idx],
    position: pos,
  }));
}

/* ---------- Main Export ---------- */

export async function optimizeItinerary(
  itineraryId: string,
  userId: string,
  role: string,
  dayNumber?: number,
): Promise<RoutingSuggestion[]> {
  await enforceItineraryOwnership(itineraryId, userId, role);

  const prisma = getPrisma();

  const where: Record<string, unknown> = { itineraryId };
  if (dayNumber !== undefined) where.dayNumber = dayNumber;

  const allItems = await prisma.itineraryItem.findMany({
    where,
    include: { resource: true },
    orderBy: [{ dayNumber: 'asc' }, { position: 'asc' }, { startTime: 'asc' }],
  });

  if (allItems.length === 0) {
    throw new AppError(404, NOT_FOUND, 'No items found for optimization');
  }

  // Group items by day
  const dayGroups = new Map<number, typeof allItems>();
  for (const item of allItems) {
    const day = item.dayNumber;
    if (!dayGroups.has(day)) dayGroups.set(day, []);
    dayGroups.get(day)!.push(item);
  }

  const allResourceIds = [...new Set(allItems.map((i) => i.resourceId))];
  const travelMap = await loadTravelTimes(allResourceIds);

  const suggestions: RoutingSuggestion[] = [];

  for (const [day, dayItems] of dayGroups) {
    // Current total travel for baseline comparison
    const currentIds = dayItems.map((i) => i.resourceId);
    const currentTravel = totalTravel(currentIds, travelMap);

    // Cluster items by area
    const clusters = new Map<string, typeof dayItems>();
    for (const item of dayItems) {
      const key = clusterKey(item.resource);
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key)!.push(item);
    }

    // For each cluster, find best orderings via nearest-neighbor
    // Then combine cluster orderings and score them
    const clusterArrangements: { cluster: string; arrangements: { order: number[]; travel: number }[] }[] = [];

    for (const [key, clusterItems] of clusters) {
      const mapped: RoutingSuggestionItem[] = clusterItems.map((ci) => ({
        id: ci.id,
        resourceId: ci.resourceId,
        dayNumber: ci.dayNumber,
        startTime: ci.startTime,
        endTime: ci.endTime,
        notes: ci.notes,
        position: ci.position,
        resource: {
          id: ci.resource.id,
          name: ci.resource.name,
          city: ci.resource.city,
          region: ci.resource.region,
        },
      }));
      const arrangements = generateArrangements(mapped, travelMap);
      clusterArrangements.push({ cluster: key, arrangements });
    }

    // Build full-day suggestions by picking best arrangement per cluster,
    // then ordering clusters by inter-cluster travel
    const clusterKeys = [...clusters.keys()];
    const bestPerCluster = new Map<string, { order: number[]; travel: number }>();
    for (const ca of clusterArrangements) {
      const sorted = [...ca.arrangements].sort((a, b) => a.travel - b.travel);
      bestPerCluster.set(ca.cluster, sorted[0]);
    }

    // Generate multiple candidate orderings:
    // 1. Best intra-cluster NN
    // 2. Reverse cluster order
    // 3. Original order
    const candidateOrderings: { items: RoutingSuggestionItem[]; reason: string }[] = [];

    // Candidate 1: clusters grouped, best NN within each
    {
      const ordered: RoutingSuggestionItem[] = [];
      for (const key of clusterKeys) {
        const clusterItems = clusters.get(key)!;
        const best = bestPerCluster.get(key)!;
        const mapped = clusterItems.map((ci) => ({
          id: ci.id,
          resourceId: ci.resourceId,
          dayNumber: ci.dayNumber,
          startTime: ci.startTime,
          endTime: ci.endTime,
          notes: ci.notes,
          position: ci.position,
          resource: {
            id: ci.resource.id,
            name: ci.resource.name,
            city: ci.resource.city,
            region: ci.resource.region,
          },
        }));
        const reordered = reorderItems(mapped, best.order);
        ordered.push(...reordered);
      }
      candidateOrderings.push({
        items: ordered,
        reason: `Area-clustered route: groups nearby attractions (${clusterKeys.join(', ')}) and optimizes within each area`,
      });
    }

    // Candidate 2: reversed cluster order
    {
      const reversed = [...clusterKeys].reverse();
      const ordered: RoutingSuggestionItem[] = [];
      for (const key of reversed) {
        const clusterItems = clusters.get(key)!;
        const best = bestPerCluster.get(key)!;
        const mapped = clusterItems.map((ci) => ({
          id: ci.id,
          resourceId: ci.resourceId,
          dayNumber: ci.dayNumber,
          startTime: ci.startTime,
          endTime: ci.endTime,
          notes: ci.notes,
          position: ci.position,
          resource: {
            id: ci.resource.id,
            name: ci.resource.name,
            city: ci.resource.city,
            region: ci.resource.region,
          },
        }));
        const reordered = reorderItems(mapped, best.order);
        ordered.push(...reordered);
      }
      candidateOrderings.push({
        items: ordered,
        reason: `Reverse area-clustered route: visits areas in reverse order for alternative starting point`,
      });
    }

    // Candidate 3: global nearest-neighbor ignoring clusters
    {
      const mapped: RoutingSuggestionItem[] = dayItems.map((ci) => ({
        id: ci.id,
        resourceId: ci.resourceId,
        dayNumber: ci.dayNumber,
        startTime: ci.startTime,
        endTime: ci.endTime,
        notes: ci.notes,
        position: ci.position,
        resource: {
          id: ci.resource.id,
          name: ci.resource.name,
          city: ci.resource.city,
          region: ci.resource.region,
        },
      }));
      const arrangements = generateArrangements(mapped, travelMap);
      const best = [...arrangements].sort((a, b) => a.travel - b.travel)[0];
      const ordered = reorderItems(mapped, best.order);
      candidateOrderings.push({
        items: ordered,
        reason: 'Global shortest-path route: nearest-neighbor across all items regardless of area',
      });
    }

    // Score and rank
    const scored = candidateOrderings.map((c) => {
      const ids = c.items.map((i) => i.resourceId);
      const travel = totalTravel(ids, travelMap);
      return { ...c, totalTravelMinutes: travel };
    });

    // Sort by total travel ascending
    scored.sort((a, b) => a.totalTravelMinutes - b.totalTravelMinutes);

    // Deduplicate by item id sequence
    const seenSequences = new Set<string>();
    const unique = scored.filter((s) => {
      const key = s.items.map((i) => i.id).join(',');
      if (seenSequences.has(key)) return false;
      seenSequences.add(key);
      return true;
    });

    // Take top 3
    const top3 = unique.slice(0, 3);

    for (let rank = 0; rank < top3.length; rank++) {
      const s = top3[rank];
      suggestions.push({
        rank: rank + 1,
        dayNumber: day,
        items: s.items.map((item, idx) => ({ ...item, position: idx })),
        totalTravelMinutes: s.totalTravelMinutes,
        estimatedTimeSaved: Math.max(0, currentTravel - s.totalTravelMinutes),
        reason: s.reason,
      });
    }
  }

  return suggestions;
}
