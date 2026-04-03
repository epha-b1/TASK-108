import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getPrisma } from '../config/database';
import { Prisma } from '../models/prisma';
import { logger } from '../utils/logger';
import { IDEMPOTENCY_CONFLICT } from '../utils/errors';

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

function buildFingerprint(req: Request): string {
  const authHeader = req.headers.authorization;
  let actor = 'anonymous';
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(Buffer.from(authHeader.slice(7).split('.')[1], 'base64').toString());
      actor = payload.userId || 'anonymous';
    } catch { /* malformed token */ }
  }
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

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (!idempotencyKey) {
    res.status(400).json({
      statusCode: 400,
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header is required for mutating operations',
    });
    return;
  }

  res.setHeader('Idempotency-Key', idempotencyKey);
  const fingerprint = buildFingerprint(req);

  try {
    const prisma = getPrisma();
    const existing = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });

    if (existing && existing.expiresAt > new Date()) {
      const stored = existing.responseBody as Record<string, unknown>;
      const storedFingerprint = stored._fingerprint as string | undefined;

      if (storedFingerprint && storedFingerprint !== fingerprint) {
        res.status(409).json({
          statusCode: 409,
          code: IDEMPOTENCY_CONFLICT,
          message: 'Idempotency key already used with different request parameters',
        });
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

    // Reserve the key with fingerprint BEFORE processing to prevent races
    await prisma.idempotencyKey.upsert({
      where: { key: idempotencyKey },
      update: {
        responseBody: { _fingerprint: fingerprint, _statusCode: 0, _body: null } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
      create: {
        key: idempotencyKey,
        operationType: `${req.method} ${req.originalUrl.replace(/[0-9a-f-]{36}/gi, ':id')}`,
        responseBody: { _fingerprint: fingerprint, _statusCode: 0, _body: null } as unknown as Prisma.InputJsonValue,
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
