import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request correlation context.
 *
 * Canonical field name is `requestId` everywhere — in API responses, in
 * structured log entries, and in audit log rows. The legacy `traceId` /
 * `getTraceId()` accessors are kept as backwards-compatible aliases so we can
 * eliminate drift in one pass without changing every call site at once.
 */
export const requestStore = new AsyncLocalStorage<{ requestId: string }>();

/** Canonical accessor — returns the current request's correlation id, if any. */
export function getRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

/** @deprecated use getRequestId() instead — kept for backwards compatibility. */
export function getTraceId(): string | undefined {
  return getRequestId();
}

const requestIdFormat = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) {
    info.requestId = requestId;
  }
  return info;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    requestIdFormat(),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
  ],
  silent: process.env.NODE_ENV === 'test',
});
