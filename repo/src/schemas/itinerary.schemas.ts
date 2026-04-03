import { z } from 'zod';

export const createItinerarySchema = z.object({
  title: z.string().min(1, 'Title is required'),
  destination: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const updateItinerarySchema = z.object({
  title: z.string().min(1).optional(),
  destination: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const addItemSchema = z.object({
  resourceId: z.string().uuid('resourceId must be a UUID'),
  dayNumber: z.number().int().min(1, 'dayNumber must be >= 1'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  notes: z.string().optional(),
});

export const updateItemSchema = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  notes: z.string().optional(),
});
