import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestStore, requestLog } from '../utils/logger';

/**
 * Per-request correlation middleware.
 *
 * Canonical request id is `requestId`. We accept either `X-Request-Id` (the
 * documented header) or the legacy `X-Trace-Id` from clients, generate a
 * fresh UUID if neither is present, and:
 *
 *   - Echo the value back as both `X-Request-Id` (canonical) and `X-Trace-Id`
 *     (legacy alias) on every response so existing clients keep working.
 *   - Stash it in AsyncLocalStorage so error responses, audit log rows, and
 *     structured log entries can pick it up without threading it through
 *     every call.
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    (req.headers['x-request-id'] as string) ||
    (req.headers['x-trace-id'] as string) ||
    uuidv4();

  // Canonical header — what the spec promises and what tests assert on.
  res.setHeader('X-Request-Id', requestId);
  // Legacy alias — keeps any existing client code working.
  res.setHeader('X-Trace-Id', requestId);

  requestStore.run({ requestId }, () => {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      // Per the structured-log category standard, request-completion lines
      // are tagged `category: 'request'`. requestId is auto-injected by the
      // global format from AsyncLocalStorage.
      requestLog.info('request completed', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        duration,
      });
    });

    next();
  });
}
