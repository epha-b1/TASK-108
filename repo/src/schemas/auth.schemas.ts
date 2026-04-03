import { z } from 'zod';

export const registerSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  securityQuestions: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })).length(2, 'Exactly 2 security questions are required'),
});

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  deviceFingerprint: z.string().optional(),
  lastKnownCity: z.string().optional(),
  challengeToken: z.string().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(12, 'New password must be at least 12 characters'),
});

export const recoverSchema = z.object({
  username: z.string().min(1),
  answers: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })).min(1),
  newPassword: z.string().min(12),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});
