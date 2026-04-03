import { z } from 'zod';

export const registerModelSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Must be semantic version (e.g. 1.0.0)'),
  type: z.enum(['pmml', 'onnx', 'custom']),
  config: z.record(z.unknown()).optional(),
});

export const updateModelStatusSchema = z.object({
  status: z.enum(['inactive', 'active', 'canary']),
});

export const abAllocationSchema = z.object({
  groupName: z.string().min(1),
  percentage: z.number().min(0).max(100),
});

export const inferSchema = z.object({
  input: z.record(z.unknown()),
  context: z.record(z.unknown()).optional(),
});
