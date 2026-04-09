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

/* ---------------------------------------------------------------------------
 * Structured-log category taxonomy.
 *
 * Every meaningful structured log entry written by TripForge carries a
 * `category` field drawn from this closed set, so observability tooling can
 * filter / alert / dashboard by domain without parsing free text. The set is
 * intentionally small and stable; adding a new category is a deliberate
 * change that touches the LogCategory union below AND
 * docs/design.md "Logging" section.
 *
 *  request       — HTTP middleware: per-request completion line, slow request, etc.
 *  auth          — login/logout/password/challenge/device flows
 *  rbac          — role/permission/menu/user-role mutations
 *  itinerary     — itinerary CRUD, items, versions, sharing, optimisation
 *  resource      — resource CRUD, hours, closures, travel times
 *  import        — bulk import upload/commit/rollback
 *  model         — model registry, allocations, inference adapter events
 *  notification  — notification send, template ops, outbox processor
 *  audit         — audit-row write failures (the writes themselves are
 *                  recorded in the audit_logs table, not the JSON log)
 *  system        — startup, shutdown, unhandled errors, scheduler ticks
 * --------------------------------------------------------------------------- */
export const LOG_CATEGORIES = [
  'request',
  'auth',
  'rbac',
  'itinerary',
  'resource',
  'import',
  'model',
  'notification',
  'audit',
  'system',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

/**
 * Winston format that always injects the current `requestId` (when an
 * AsyncLocalStorage frame is active) into structured log entries.
 *
 * It does NOT inject `category` — that comes from the call site so that
 * every log line is forced to declare its taxonomy explicitly. The category
 * loggers below ensure call sites can't forget.
 */
const requestIdFormat = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) {
    info.requestId = requestId;
  }
  return info;
});

/**
 * Underlying winston logger. Application code SHOULD NOT use this directly —
 * use one of the category-bound loggers below (`authLog`, `requestLog`, etc.)
 * so the `category` field is set automatically. The raw `logger` is exported
 * only for legacy call sites that we are still in the process of migrating
 * and for tests that want to monkey-patch transports.
 */
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

/* ---------------------------------------------------------------------------
 * Category-bound logger factory.
 *
 * `categoryLogger('auth')` returns a thin wrapper that exposes the same
 * surface as the winston logger (info / warn / error / debug) but always
 * merges `{ category: 'auth' }` into the `meta` object before forwarding.
 *
 * This is the ONLY supported way to write structured domain logs. It's
 * impossible to call `authLog.info(...)` without producing a row that
 * carries `category: 'auth'`.
 * --------------------------------------------------------------------------- */
export interface CategoryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function categoryLogger(category: LogCategory): CategoryLogger {
  const tag = { category };
  return {
    info: (message, meta = {}) => logger.info(message, { ...tag, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { ...tag, ...meta }),
    error: (message, meta = {}) => logger.error(message, { ...tag, ...meta }),
    debug: (message, meta = {}) => logger.debug(message, { ...tag, ...meta }),
  };
}

/* Pre-bound loggers — one per category in the taxonomy. */
export const requestLog = categoryLogger('request');
export const authLog = categoryLogger('auth');
export const rbacLog = categoryLogger('rbac');
export const itineraryLog = categoryLogger('itinerary');
export const resourceLog = categoryLogger('resource');
export const importLog = categoryLogger('import');
export const modelLog = categoryLogger('model');
export const notificationLog = categoryLogger('notification');
export const auditLog = categoryLogger('audit');
export const systemLog = categoryLogger('system');
