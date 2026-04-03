import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getPrisma } from '../config/database';
import { env } from '../config/environment';
import { authConfig } from '../config/auth';
import { encrypt, decrypt, hashSha256 } from '../utils/crypto';
import { AppError, VALIDATION_ERROR, UNAUTHORIZED, CONFLICT, NOT_FOUND, RATE_LIMITED } from '../utils/errors';
import { JwtPayload, TokenPair, UserRole } from '../types/auth.types';

const BCRYPT_ROUNDS = 12;
const MAX_DEVICES = 5;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;
const PASSWORD_HISTORY_COUNT = 5;

export function validatePasswordPolicy(password: string): void {
  if (password.length < 12) {
    throw new AppError(400, VALIDATION_ERROR, 'Password must be at least 12 characters');
  }
  if (!/[A-Z]/.test(password)) {
    throw new AppError(400, VALIDATION_ERROR, 'Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    throw new AppError(400, VALIDATION_ERROR, 'Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    throw new AppError(400, VALIDATION_ERROR, 'Password must contain at least one digit');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new AppError(400, VALIDATION_ERROR, 'Password must contain at least one special character');
  }
}

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: authConfig.algorithm,
    expiresIn: authConfig.accessTokenTtl,
  });
}

export function signRefreshToken(): string {
  return uuidv4() + '-' + uuidv4();
}

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.jwtSecret, {
      algorithms: [authConfig.algorithm],
    }) as JwtPayload;
  } catch {
    throw new AppError(401, UNAUTHORIZED, 'Invalid or expired token');
  }
}

export async function register(
  username: string,
  password: string,
  securityQuestions: Array<{ question: string; answer: string }>,
): Promise<{ id: string; username: string }> {
  const prisma = getPrisma();

  validatePasswordPolicy(password);

  if (!securityQuestions || securityQuestions.length !== 2) {
    throw new AppError(400, VALIDATION_ERROR, 'Exactly 2 security questions are required');
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    throw new AppError(409, CONFLICT, 'Username already taken');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      securityQuestions: {
        create: securityQuestions.map((sq) => ({
          question: sq.question,
          answerEncrypted: encrypt(sq.answer.trim().toLowerCase()),
        })),
      },
      passwordHistory: {
        create: { passwordHash },
      },
    },
  });

  return { id: user.id, username: user.username };
}

export async function login(
  username: string,
  password: string,
  deviceFingerprint?: string,
  lastKnownCity?: string,
  challengeToken?: string,
): Promise<{ tokens: TokenPair; user: { id: string; username: string; role: string } } | { challengeToken: string; retryAfterSeconds: number; message: string }> {
  const prisma = getPrisma();

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    throw new AppError(401, UNAUTHORIZED, 'Invalid credentials');
  }

  // Rolling lockout: auto-unlock if lock window has expired
  if (user.lockedUntil && user.lockedUntil <= new Date()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: null, status: 'active' },
    });
    user.lockedUntil = null;
    user.status = 'active';
  }

  if (user.status === 'locked' || (user.lockedUntil && user.lockedUntil > new Date())) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Account is locked. Try again later.');
  }

  if (user.status === 'suspended') {
    throw new AppError(403, 'FORBIDDEN', 'Account is suspended');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    // Record the failed attempt
    await prisma.loginAttempt.create({
      data: { userId: user.id, success: false },
    });

    // Count failures in the rolling 15-minute window
    const windowStart = new Date(Date.now() - LOCKOUT_MINUTES * 60 * 1000);
    const recentFailures = await prisma.loginAttempt.count({
      where: {
        userId: user.id,
        success: false,
        createdAt: { gte: windowStart },
      },
    });

    if (recentFailures >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: lockUntil, status: 'locked' },
      });
    }

    throw new AppError(401, UNAUTHORIZED, 'Invalid credentials');
  }

  // Successful login — record it and clear lock state
  await prisma.loginAttempt.create({
    data: { userId: user.id, success: true },
  });
  if (user.status === 'locked' || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: null, status: 'active' },
    });
  }

  // Device registration
  const fpHash = deviceFingerprint
    ? hashSha256(deviceFingerprint)
    : hashSha256(uuidv4());

  let device = await prisma.device.findUnique({
    where: { userId_fingerprintHash: { userId: user.id, fingerprintHash: fpHash } },
  });

  if (!device) {
    const deviceCount = await prisma.device.count({ where: { userId: user.id } });
    if (deviceCount >= MAX_DEVICES) {
      // Return 409 with device list so client can prompt removal
      const existingDevices = await prisma.device.findMany({
        where: { userId: user.id },
        select: { id: true, lastSeenAt: true, lastKnownCity: true, createdAt: true },
        orderBy: { lastSeenAt: 'desc' },
      });
      throw new AppError(
        409,
        'DEVICE_LIMIT_REACHED',
        `Maximum ${MAX_DEVICES} devices allowed. Remove a device first.`,
        { devices: existingDevices },
      );
    }

    device = await prisma.device.create({
      data: {
        userId: user.id,
        fingerprintHash: fpHash,
        lastSeenAt: new Date(),
        lastKnownCity: lastKnownCity || null,
      },
    });
  } else {
    // If challengeToken provided, validate it and skip location check
    if (challengeToken) {
      // Find the per-attempt challenge record by token
      const attemptKey = `challenge:${user.id}:${fpHash}:${challengeToken}`;
      const challenge = await prisma.idempotencyKey.findUnique({ where: { key: attemptKey } });
      if (!challenge || challenge.expiresAt < new Date() || challenge.operationType !== 'location_challenge') {
        throw new AppError(401, UNAUTHORIZED, 'Invalid or expired challenge token');
      }
      // Consume the challenge token (one-time use)
      await prisma.idempotencyKey.delete({ where: { key: attemptKey } });
      // Update device city
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date(), lastKnownCity },
      });
    } else if (
      lastKnownCity &&
      device.lastKnownCity &&
      lastKnownCity.trim().toLowerCase() !== device.lastKnownCity.trim().toLowerCase()
    ) {
      // Unusual location detection — issue a challenge token
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Rate limit: count per-attempt challenge rows in the last rolling hour
      const recentChallenges = await prisma.idempotencyKey.findMany({
        where: {
          key: { startsWith: `challenge:${user.id}:${fpHash}:` },
          operationType: 'location_challenge',
          createdAt: { gte: oneHourAgo },
        },
      });

      if (recentChallenges.length >= 3) {
        // Find the oldest challenge in the window to compute retryAfter
        const oldest = recentChallenges.reduce((a, b) =>
          a.createdAt < b.createdAt ? a : b,
        );
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest.createdAt.getTime() + 3600000 - Date.now()) / 1000));
        throw new AppError(429, RATE_LIMITED, `Too many challenge attempts. Retry after ${retryAfterSeconds} seconds.`);
      }

      // Generate unique per-attempt challenge token
      const newChallengeToken = uuidv4();
      const attemptKey = `challenge:${user.id}:${fpHash}:${newChallengeToken}`;

      await prisma.idempotencyKey.create({
        data: {
          key: attemptKey,
          operationType: 'location_challenge',
          responseBody: {
            challengeToken: newChallengeToken,
            cityFrom: device.lastKnownCity,
            cityTo: lastKnownCity,
          },
          expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5-minute TTL
        },
      });

      return {
        challengeToken: newChallengeToken,
        retryAfterSeconds: 300,
        message: 'Unusual location detected. Please confirm your identity.',
      };
    } else {
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date(), lastKnownCity: lastKnownCity || device.lastKnownCity },
      });
    }
  }

  // Issue tokens
  const accessToken = signAccessToken({
    userId: user.id,
    username: user.username,
    role: user.role as UserRole,
  });

  const rawRefreshToken = signRefreshToken();
  const tokenHash = hashSha256(rawRefreshToken);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      deviceId: device.id,
      tokenHash,
      expiresAt: new Date(Date.now() + authConfig.refreshTokenTtl * 1000),
    },
  });

  return {
    tokens: { accessToken, refreshToken: rawRefreshToken },
    user: { id: user.id, username: user.username, role: user.role },
  };
}

export async function refresh(refreshToken: string): Promise<{ accessToken: string }> {
  const prisma = getPrisma();
  const tokenHash = hashSha256(refreshToken);

  const stored = await prisma.refreshToken.findFirst({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AppError(401, UNAUTHORIZED, 'Invalid or expired refresh token');
  }

  if (stored.user.status !== 'active') {
    throw new AppError(403, 'FORBIDDEN', 'Account is not active');
  }

  const accessToken = signAccessToken({
    userId: stored.user.id,
    username: stored.user.username,
    role: stored.user.role as UserRole,
  });

  return { accessToken };
}

export async function logout(refreshToken: string): Promise<void> {
  const prisma = getPrisma();
  const tokenHash = hashSha256(refreshToken);

  const stored = await prisma.refreshToken.findFirst({
    where: { tokenHash },
  });

  if (stored && !stored.revokedAt) {
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
  }
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const prisma = getPrisma();

  validatePasswordPolicy(newPassword);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, NOT_FOUND, 'User not found');
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new AppError(401, UNAUTHORIZED, 'Current password is incorrect');
  }

  // Check last 5 passwords for reuse
  const history = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: PASSWORD_HISTORY_COUNT,
  });

  for (const entry of history) {
    const reused = await bcrypt.compare(newPassword, entry.passwordHash);
    if (reused) {
      throw new AppError(400, VALIDATION_ERROR, 'Cannot reuse any of your last 5 passwords');
    }
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  await prisma.passwordHistory.create({
    data: { userId, passwordHash: newHash },
  });
}

export async function recoverPassword(
  username: string,
  answers: Array<{ question: string; answer: string }>,
  newPassword: string,
): Promise<void> {
  const prisma = getPrisma();

  validatePasswordPolicy(newPassword);

  const user = await prisma.user.findUnique({
    where: { username },
    include: { securityQuestions: true },
  });

  if (!user) {
    throw new AppError(401, UNAUTHORIZED, 'Invalid username or answers');
  }

  if (user.securityQuestions.length === 0) {
    throw new AppError(401, UNAUTHORIZED, 'Invalid username or answers');
  }

  // Verify all stored questions have matching answers
  let allMatch = true;
  for (const stored of user.securityQuestions) {
    const storedAnswer = decrypt(stored.answerEncrypted).trim().toLowerCase();
    const provided = answers.find(
      (a) => a.question.trim().toLowerCase() === stored.question.trim().toLowerCase(),
    );
    if (!provided || provided.answer.trim().toLowerCase() !== storedAnswer) {
      allMatch = false;
      break;
    }
  }

  if (!allMatch) {
    throw new AppError(401, UNAUTHORIZED, 'Invalid username or answers');
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newHash,
      failedAttempts: 0,
      lockedUntil: null,
      status: 'active',
    },
  });

  await prisma.passwordHistory.create({
    data: { userId: user.id, passwordHash: newHash },
  });
}

export async function getMe(userId: string) {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, role: true, status: true, createdAt: true },
  });
  if (!user) {
    throw new AppError(404, NOT_FOUND, 'User not found');
  }
  return user;
}

export async function getDevices(userId: string) {
  const prisma = getPrisma();
  return prisma.device.findMany({
    where: { userId },
    select: { id: true, fingerprintHash: true, lastSeenAt: true, lastKnownCity: true, createdAt: true },
    orderBy: { lastSeenAt: 'desc' },
  });
}

export async function removeDevice(userId: string, deviceId: string): Promise<void> {
  const prisma = getPrisma();
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId },
  });
  if (!device) {
    throw new AppError(404, NOT_FOUND, 'Device not found');
  }

  // Revoke all refresh tokens for this device
  await prisma.refreshToken.updateMany({
    where: { deviceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await prisma.device.delete({ where: { id: deviceId } });
}
