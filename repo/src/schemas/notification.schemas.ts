import { z } from 'zod';

export const sendNotificationSchema = z.object({
  userId: z.string().uuid('userId must be a UUID'),
  type: z.string().min(1, 'type is required'),
  templateCode: z.string().optional(),
  variables: z.record(z.unknown()).optional(),
  subject: z.string().optional(),
  message: z.string().optional(),
});

export const createTemplateSchema = z.object({
  code: z.string().min(1, 'code is required'),
  subject: z.string().optional(),
  body: z.string().min(1, 'body is required'),
});

export const updateTemplateSchema = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
});
