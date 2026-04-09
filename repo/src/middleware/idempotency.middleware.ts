import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getPrisma } from '../config/database';
import { Prisma } from '../models/prisma';
import { logger, getRequestId } from '../utils/logger';
import { IDEMPOTENCY_CONFLICT, UNAUTHORIZED } from '../utils/errors';
import { env } from '../config/environment';
import { authConfig } from '../config/auth';

/**
 * Build the canonical error envelope. The middleware writes responses
 * directly (rather than throwing AppError) because some of these branches
 * happen before the route handler is reached, but we still need to honour
 * the requestId/X-Request-Id contract that envelope.api.spec.ts asserts on.
 */
function envelope(statusCode: number, code: string, message: string) {
  const requestId = getRequestId();
  return { statusCode, code, message, requestId, traceId: requestId };
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const TTL_MS = 24 * 60 * 60 * 1000;

const SENSITIVE_KEYS = new Set(['accessToken', 'refreshToken', 'token', 'tokenHash', 'password', 'passwordHash']);

function redactSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redactSecrets(v);
  }
  return out;
}

interface VerifiedActor {
  /** Stable actor identifier used for fingerprinting and access control. */
  actor: string;
  /** True iff a Bearer token was provided AND its signature failed verification. */
  invalid: boolean;
}

/**
 * Resolve the requesting actor by *cryptographically verifying* the bearer token.
 *
 * Returning the unverified JWT payload (the previous behaviour) was the root
 * cause of the auth-boundary replay risk: an attacker could forge a token whose
 * payload claimed any user id, match the stored idempotency fingerprint, and
 * receive the cached success response without ever proving their identity.
 *
 * - No bearer header                       → 'anonymous'
 * - Bearer header with valid signature      → verified userId
 * - Bearer header with invalid signature    → 'invalid' + invalid=true
 */
function resolveActor(req: Request): VerifiedActor {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { actor: 'anonymous', invalid: false };
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), env.jwtSecret, {
      algorithms: [authConfig.algorithm],
    }) as { userId?: string };
    return { actor: payload.userId || 'anonymous', invalid: false };
  } catch {
    return { actor: 'invalid', invalid: true };
  }
}

function buildFingerprint(req: Request, actor: string): string {
  const method = req.method;
  const route = req.originalUrl.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
  const bodyHash = req.body && Object.keys(req.body).length > 0
    ? crypto.createHash('sha256').update(JSON.stringify(req.body, Object.keys(req.body).sort())).digest('hex')
    : 'empty';
  return crypto.createHash('sha256').update(`${actor}:${method}:${route}:${bodyHash}`).digest('hex');
}

export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  // Verify the bearer token (if any) BEFORE participating in idempotency.
  // A request that presents an invalid/forged bearer must never be able to
  // observe or overwrite a cached response that was produced for a real
  // authenticated user. We pass it through so the downstream auth middleware
  // returns 401 — the client gets a clear auth failure rather than a
  // misleading replayed success.
  const verified = resolveActor(req);
  if (verified.invalid) {
    next();
    return;
  }

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (!idempotencyKey) {
    res.status(400).json(
      envelope(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required for mutating operations'),
    );
    return;
  }

  res.setHeader('Idempotency-Key', idempotencyKey);
  const actor = verified.actor;
  const fingerprint = buildFingerprint(req, actor);

  try {
    const prisma = getPrisma();
    const existing = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });

    if (existing && existing.expiresAt > new Date()) {
      const stored = existing.responseBody as Record<string, unknown>;
      const storedActor = stored._actor as string | undefined;
      const storedFingerprint = stored._fingerprint as string | undefined;

      // Cross-actor protection: if the cached entry was produced for a
      // verified user, only that same verified user is allowed to observe or
      // overwrite the cache. Anyone else (anonymous, a different verified
      // user) is treated as making a brand-new request that simply happens to
      // share an opaque key — pass it through without serving cache and
      // without poisoning the existing record.
      if (storedActor && storedActor !== 'anonymous' && storedActor !== actor) {
        if (actor === 'anonymous') {
          // Protected route + cached entry belongs to someone else: short
          // circuit with 401 so the client gets the right signal. (We can't
          // continue to the route's auth middleware reliably because public
          // routes also use this middleware; for those a missing token is
          // fine, but if the cache is bound to an authenticated identity we
          // know we're on a protected route.)
          res.status(401).json(envelope(401, UNAUTHORIZED, 'Authentication required'));
          return;
        }
        // Different verified user: don't replay, don't overwrite. Let the
        // request execute fresh under its own identity.
        next();
        return;
      }

      if (storedFingerprint && storedFingerprint !== fingerprint) {
        res.status(409).json(
          envelope(409, IDEMPOTENCY_CONFLICT, 'Idempotency key already used with different request parameters'),
        );
        return;
      }

      const statusCode = (stored._statusCode as number) ?? 0;
      if (statusCode > 0) {
        // Completed — replay
        const body = stored._body ?? {};
        res.status(statusCode).json(body);
        return;
      }
      // statusCode 0 = still processing first request; wait briefly then re-check
      await new Promise((r) => setTimeout(r, 200));
      const refreshed = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (refreshed) {
        const ref = refreshed.responseBody as Record<string, unknown>;
        const sc = (ref._statusCode as number) ?? 0;
        if (sc > 0) {
          res.status(sc).json(ref._body ?? {});
          return;
        }
      }
      // Still processing — let it through (dedup is best-effort for concurrent requests)
    }

    // Reserve the key with fingerprint + actor BEFORE processing to prevent races
    await prisma.idempotencyKey.upsert({
      where: { key: idempotencyKey },
      update: {
        responseBody: { _fingerprint: fingerprint, _actor: actor, _statusCode: 0, _body: null } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
      create: {
        key: idempotencyKey,
        operationType: `${req.method} ${req.originalUrl.replace(/[0-9a-f-]{36}/gi, ':id')}`,
        responseBody: { _fingerprint: fingerprint, _actor: actor, _statusCode: 0, _body: null } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    // Intercept response to update the stored record with actual result
    const originalJson = res.json.bind(res);

    res.json = function interceptJson(body: unknown): Response {
      const record = {
        _statusCode: res.statusCode,
        _body: redactSecrets(body),
        _fingerprint: fingerprint,
        _actor: actor,
      };
      // Update the reserved key with the actual response (fire-and-forget is OK now since key is already reserved)
      prisma.idempotencyKey.update({
        where: { key: idempotencyKey },
        data: { responseBody: record as unknown as Prisma.InputJsonValue },
      }).catch((err) => {
        logger.error('Failed to update idempotency key', { error: (err as Error).message });
      });
      return originalJson(body);
    };

    next();
  } catch (err) {
    logger.error('Idempotency middleware error', { error: (err as Error).message });
    next();
  }
}
