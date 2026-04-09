import { z } from 'zod';

/**
 * Canonical resource type enum.
 *
 * This is the single source of truth used by:
 *   - createResourceSchema (POST /resources validation)
 *   - resource.service.ts createResource / updateResource
 *   - import.service.ts row validator and commit
 *   - swagger / api-spec docs
 *
 * Add a new type here and the rest of the system picks it up automatically.
 */
export const RESOURCE_TYPES = ['attraction', 'lodging', 'meal', 'meeting'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const createResourceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(RESOURCE_TYPES),
  streetLine: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  minDwellMinutes: z.number().int().min(1).optional(),
});

export const businessHoursSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
});

export const closureSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  reason: z.string().optional(),
});

export const travelTimeSchema = z.object({
  fromResourceId: z.string().uuid(),
  toResourceId: z.string().uuid(),
  travelMinutes: z.number().int().min(0),
  transportMode: z.enum(['walking', 'driving', 'transit']).optional(),
});
