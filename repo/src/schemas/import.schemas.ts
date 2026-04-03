import { z } from 'zod';

export const uploadFieldsSchema = z.object({
  entityType: z.enum(['resources', 'itineraries'], { required_error: 'entityType is required' }),
  idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
  deduplicationKey: z.string().optional(),
});

export const batchIdParamSchema = z.object({
  batchId: z.string().uuid('batchId must be a UUID'),
});
