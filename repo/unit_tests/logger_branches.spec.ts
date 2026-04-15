/**
 * Coverage for the tiny uncovered branches in `src/utils/logger.ts`:
 *   - the deprecated `getTraceId` alias (returns the current requestId)
 *   - the `debug` category method on every pre-bound logger
 */

import {
  getTraceId,
  getRequestId,
  requestStore,
  requestLog, authLog, rbacLog, itineraryLog, resourceLog,
  importLog, modelLog, notificationLog, auditLog, systemLog,
  categoryLogger,
  LOG_CATEGORIES,
} from '../src/utils/logger';

describe('logger — deprecated accessor', () => {
  it('getTraceId returns getRequestId inside a request scope', () => {
    expect(getTraceId()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
    requestStore.run({ requestId: 'rid-xyz' }, () => {
      expect(getTraceId()).toBe('rid-xyz');
      expect(getRequestId()).toBe('rid-xyz');
    });
  });
});

describe('logger — debug method on every category logger', () => {
  it('each pre-bound category logger exposes .debug that does not throw', () => {
    // Calling debug drives the otherwise-uncovered branch in categoryLogger.
    for (const log of [requestLog, authLog, rbacLog, itineraryLog, resourceLog, importLog, modelLog, notificationLog, auditLog, systemLog]) {
      expect(() => log.debug('msg', { k: 'v' })).not.toThrow();
      expect(() => log.debug('msg')).not.toThrow();
    }
  });

  it('categoryLogger factory covers warn/info/error default-meta branches', () => {
    const c = categoryLogger('system');
    expect(() => c.info('x')).not.toThrow();
    expect(() => c.warn('x')).not.toThrow();
    expect(() => c.error('x')).not.toThrow();
    expect(() => c.debug('x')).not.toThrow();
  });

  it('LOG_CATEGORIES enumerates the full taxonomy', () => {
    expect(LOG_CATEGORIES).toEqual([
      'request', 'auth', 'rbac', 'itinerary', 'resource', 'import', 'model', 'notification', 'audit', 'system',
    ]);
  });
});
