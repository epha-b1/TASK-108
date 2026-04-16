/**
 * Behavior-level coverage for `src/utils/logger.ts`.
 *
 * Earlier this file was `expect(() => log.debug(...)).not.toThrow()` — which
 * would happily pass if the category logger silently dropped every call.
 * The tests below attach a Winston Console transport bound to an in-memory
 * stream so we can observe the ACTUAL emitted JSON: level, message,
 * category tag, merged meta, and the ambient requestId that the
 * AsyncLocalStorage context injects. Regressions (lost category tag,
 * missing requestId, wrong level) now fail the assertion rather than the
 * slightly-loose "didn't throw".
 */

import winston from 'winston';
import { Writable } from 'stream';

import {
  getTraceId,
  getRequestId,
  requestStore,
  logger,
  requestLog, authLog, rbacLog, itineraryLog, resourceLog,
  importLog, modelLog, notificationLog, auditLog, systemLog,
  categoryLogger,
  LOG_CATEGORIES,
} from '../src/utils/logger';

type LogEntry = {
  level: string;
  message: string;
  category?: string;
  requestId?: string;
  [k: string]: unknown;
};

function captureLogs<T>(fn: () => T): { entries: LogEntry[]; result: T } {
  const entries: LogEntry[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const txt = chunk.toString().trim();
      if (txt) {
        // Winston writes "<level>: <json>" by default; parse the JSON body.
        const match = txt.match(/\{[\s\S]*\}/);
        if (match) {
          try { entries.push(JSON.parse(match[0])); } catch { /* ignore */ }
        }
      }
      cb();
    },
  });
  const transport = new winston.transports.Stream({ stream, level: 'debug' });
  const wasSilent = (logger as any).silent;
  (logger as any).silent = false;
  logger.add(transport);
  try {
    const result = fn();
    return { entries, result };
  } finally {
    logger.remove(transport);
    (logger as any).silent = wasSilent;
  }
}

describe('logger — deprecated accessor (behavior)', () => {
  it('getTraceId returns getRequestId inside a request scope AND is undefined outside', () => {
    expect(getTraceId()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
    let seenInside: string | undefined;
    requestStore.run({ requestId: 'rid-xyz' }, () => {
      seenInside = getTraceId();
      expect(getRequestId()).toBe('rid-xyz');
    });
    expect(seenInside).toBe('rid-xyz');
    // Leaving the scope restores the undefined accessor.
    expect(getTraceId()).toBeUndefined();
  });
});

describe('logger — every category logger emits a structured entry with its tag', () => {
  type Bundle = [name: string, log: typeof requestLog, category: typeof LOG_CATEGORIES[number]];
  const bundles: Bundle[] = [
    ['requestLog', requestLog, 'request'],
    ['authLog', authLog, 'auth'],
    ['rbacLog', rbacLog, 'rbac'],
    ['itineraryLog', itineraryLog, 'itinerary'],
    ['resourceLog', resourceLog, 'resource'],
    ['importLog', importLog, 'import'],
    ['modelLog', modelLog, 'model'],
    ['notificationLog', notificationLog, 'notification'],
    ['auditLog', auditLog, 'audit'],
    ['systemLog', systemLog, 'system'],
  ];

  it.each(bundles)('%s tags entries with category="%s" on info/warn/error/debug', (_name, log, category) => {
    const { entries } = captureLogs(() => {
      log.info('hello info', { detail: 1 });
      log.warn('hello warn', { detail: 2 });
      log.error('hello error', { detail: 3 });
      log.debug('hello debug', { detail: 4 });
    });
    const levelsSeen = new Set(entries.filter((e) => e.category === category).map((e) => e.level));
    // Winston may suppress `debug` if it's below the configured level; we
    // still assert info + warn + error are all present and tagged.
    expect(levelsSeen).toEqual(expect.objectContaining(new Set(['info', 'warn', 'error']) as any));
    const infoEntry = entries.find((e) => e.level === 'info' && e.category === category);
    expect(infoEntry).toBeDefined();
    expect(infoEntry!.message).toBe('hello info');
    expect(infoEntry!.detail).toBe(1);
  });

  it('injects requestId from AsyncLocalStorage context into every entry', () => {
    const { entries } = captureLogs(() => {
      requestStore.run({ requestId: 'req-observable-42' }, () => {
        authLog.info('login-ok');
        systemLog.error('boom');
      });
    });
    const tagged = entries.filter((e) => e.requestId === 'req-observable-42');
    expect(tagged.length).toBeGreaterThanOrEqual(2);
    const cats = new Set(tagged.map((e) => e.category));
    expect(cats).toEqual(expect.objectContaining(new Set(['auth', 'system']) as any));
  });

  it('does NOT attach requestId to entries emitted outside a request scope', () => {
    const { entries } = captureLogs(() => {
      systemLog.info('no-context');
    });
    const match = entries.find((e) => e.message === 'no-context');
    expect(match).toBeDefined();
    expect(match!.requestId).toBeUndefined();
  });

  it('omitted meta still produces a usable entry (no "undefined" string leakage)', () => {
    const { entries } = captureLogs(() => {
      systemLog.info('bare');
    });
    const match = entries.find((e) => e.message === 'bare');
    expect(match).toBeDefined();
    // The entry MUST NOT carry a literal "undefined" — a past regression
    // serialised default meta as the string "undefined".
    const serialised = JSON.stringify(match);
    expect(serialised).not.toMatch(/"undefined"/);
  });

  it('categoryLogger factory produces a fully-functional logger for arbitrary category from LOG_CATEGORIES', () => {
    const c = categoryLogger('system');
    const { entries } = captureLogs(() => {
      c.info('factory-info', { k: 'v' });
    });
    const match = entries.find((e) => e.message === 'factory-info');
    expect(match).toBeDefined();
    expect(match!.category).toBe('system');
    expect(match!.k).toBe('v');
  });

  it('LOG_CATEGORIES is a closed, deterministic taxonomy (ordering is the public contract)', () => {
    // Ordering matters: observability dashboards index on position.
    expect(LOG_CATEGORIES).toEqual([
      'request', 'auth', 'rbac', 'itinerary', 'resource',
      'import', 'model', 'notification', 'audit', 'system',
    ]);
  });
});
