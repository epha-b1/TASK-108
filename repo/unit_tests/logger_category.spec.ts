/**
 * Tests for the structured-log category taxonomy.
 *
 * Locks the contract that EVERY structured log line emitted through one of
 * the category-bound loggers (`authLog`, `requestLog`, `systemLog`, etc.)
 * carries a stable `category` field drawn from the documented taxonomy.
 *
 * Strategy:
 *   - The shared winston `logger` is silenced in NODE_ENV=test (see
 *     src/utils/logger.ts), so we can't observe normal log calls. Instead
 *     we install a transient `Console` transport with a JSON-capturing
 *     stream, exercise each category logger plus the request middleware
 *     and the global error handler, then inspect the captured payloads.
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import { Writable } from 'stream';
import winston from 'winston';
import {
  logger,
  categoryLogger,
  authLog,
  requestLog,
  systemLog,
  importLog,
  resourceLog,
  modelLog,
  notificationLog,
  rbacLog,
  itineraryLog,
  auditLog as auditLogger,
  LOG_CATEGORIES,
} from '../src/utils/logger';
import type { CategoryLogger } from '../src/utils/logger';

interface CapturedEntry {
  level: string;
  message: string;
  category?: string;
  requestId?: string;
  [k: string]: unknown;
}

function attachCapture(): { entries: CapturedEntry[]; detach: () => void } {
  const entries: CapturedEntry[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const lines = chunk.toString().split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* ignore non-JSON noise */
        }
      }
      cb();
    },
  });
  const transport = new winston.transports.Stream({ stream });

  const wasSilent = logger.silent;
  logger.silent = false;
  logger.add(transport);

  return {
    entries,
    detach: () => {
      logger.remove(transport);
      logger.silent = wasSilent;
    },
  };
}

describe('Structured log category taxonomy', () => {
  it('exports every documented category', () => {
    expect(LOG_CATEGORIES).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it('categoryLogger("auth") tags every level with category=auth', () => {
    const cap = attachCapture();
    try {
      authLog.info('login.success', { userId: 'u1' });
      authLog.warn('login.suspicious', { userId: 'u1' });
      authLog.error('login.failed', { userId: 'u1' });
    } finally {
      cap.detach();
    }
    expect(cap.entries.length).toBe(3);
    for (const e of cap.entries) {
      expect(e.category).toBe('auth');
    }
    // Levels are preserved:
    expect(cap.entries.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
  });

  it('every pre-bound category logger emits with the matching category', () => {
    const cases: Array<[string, CategoryLogger]> = [
      ['request', requestLog],
      ['system', systemLog],
      ['import', importLog],
      ['resource', resourceLog],
      ['model', modelLog],
      ['notification', notificationLog],
      ['rbac', rbacLog],
      ['itinerary', itineraryLog],
      ['audit', auditLogger],
    ];
    const cap = attachCapture();
    try {
      for (const [, lg] of cases) {
        lg.info('probe', {});
      }
    } finally {
      cap.detach();
    }
    expect(cap.entries.length).toBe(cases.length);
    for (let i = 0; i < cases.length; i++) {
      expect(cap.entries[i].category).toBe(cases[i][0]);
      expect(cap.entries[i].message).toBe('probe');
    }
  });

  it('a custom categoryLogger() factory call also stamps the category', () => {
    const customLog = categoryLogger('itinerary');
    const cap = attachCapture();
    try {
      customLog.info('itinerary.optimize', { itineraryId: 'i1' });
    } finally {
      cap.detach();
    }
    expect(cap.entries[0].category).toBe('itinerary');
  });
});

describe('Request middleware logging integration', () => {
  it('request-completion log carries category=request and the requestId', async () => {
    // Build a tiny app that goes through auditMiddleware (which writes the
    // completion line) so we exercise the middleware end to end.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { auditMiddleware } = require('../src/middleware/audit.middleware');
    const app = express();
    app.use(auditMiddleware);
    app.get('/category-probe', (_req: Request, res: Response) => res.json({ ok: true }));

    const cap = attachCapture();
    try {
      const customRid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const res = await request(app)
        .get('/category-probe')
        .set('X-Request-Id', customRid);
      expect(res.status).toBe(200);
      // Give the 'finish' listener a tick to fire its async logger call.
      await new Promise((r) => setImmediate(r));
    } finally {
      cap.detach();
    }

    const completion = cap.entries.find((e) => e.message === 'request completed');
    expect(completion).toBeDefined();
    expect(completion!.category).toBe('request');
    expect(completion!.requestId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(completion!.statusCode).toBe(200);
    expect(typeof completion!.duration).toBe('number');
  });
});

describe('Global error handler logging integration', () => {
  it('unhandled error log carries category=system (real app + /__test__/boom)', async () => {
    // The real Express app at src/app.ts registers /__test__/boom only when
    // NODE_ENV=test (jest sets that for us), and its global error handler
    // calls systemLog.error('unhandled error', …). We hit it through
    // supertest and inspect the captured log entries.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realApp = require('../src/app').default;

    const cap = attachCapture();
    try {
      const res = await request(realApp).get('/__test__/boom');
      expect(res.status).toBe(500);
      // Allow async log writes to flush.
      await new Promise((r) => setImmediate(r));
    } finally {
      cap.detach();
    }

    const errEntry = cap.entries.find(
      (e) => e.message === 'unhandled error' && e.category === 'system',
    );
    expect(errEntry).toBeDefined();
    expect(errEntry!.category).toBe('system');
  }, 15000);
});
