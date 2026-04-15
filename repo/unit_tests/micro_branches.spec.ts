/**
 * Final micro-coverage pass: drive the specific branches the larger
 * per-feature specs missed. Each `it()` here targets a concrete line
 * or branch listed in the previous coverage report.
 */

import { Request, Response, NextFunction } from 'express';

import * as resCtl from '../src/controllers/resources.controller';
import * as itCtl from '../src/controllers/itineraries.controller';
import * as notCtl from '../src/controllers/notifications.controller';
import * as authCtl from '../src/controllers/auth.controller';
import * as auditSvc from '../src/services/audit.service';
import * as resourceService from '../src/services/resource.service';
import * as itineraryService from '../src/services/itinerary.service';
import * as notificationService from '../src/services/notification.service';
import * as authService from '../src/services/auth.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function rr(over: Partial<any> = {}) {
  const state = { statusCode: 200, body: undefined as unknown };
  const req = {
    user: { userId: 'u-actor', role: 'organizer', username: 'a' },
    body: {}, query: {}, params: {}, headers: {},
    ...over,
  } as unknown as Request;
  const res = {
    status(c: number) { state.statusCode = c; return this; },
    json(b: unknown) { state.body = b; return this; },
    send(b: unknown) { state.body = b; return this; },
    setHeader() {},
  } as unknown as Response;
  const calls: { err: unknown }[] = [];
  const next: NextFunction = (err?: unknown) => { calls.push({ err }); };
  return { req, res, next, state, calls };
}

function resetPrisma() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

beforeEach(() => {
  resetPrisma();
  jest.restoreAllMocks();
  jest.spyOn(auditSvc, 'audit').mockImplementation(() => undefined);
});

/* ========== Controllers — undefined req.body branches ========== */

describe('controllers — Object.keys(req.body ?? {}) with undefined body', () => {
  it('resources.updateResourceHandler', async () => {
    jest.spyOn(resourceService, 'updateResource').mockResolvedValue({ id: 'r1' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' }, body: undefined });
    await resCtl.updateResourceHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('itineraries.updateItineraryHandler', async () => {
    jest.spyOn(itineraryService, 'updateItinerary').mockResolvedValue({ id: 'i1' } as any);
    const { req, res, state } = rr({ params: { id: 'i1' }, body: undefined });
    await itCtl.updateItineraryHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('itineraries.updateItemHandler', async () => {
    jest.spyOn(itineraryService, 'updateItem').mockResolvedValue({ id: 'it1' } as any);
    const { req, res, state } = rr({ params: { id: 'i1', itemId: 'it1' }, body: undefined });
    await itCtl.updateItemHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('notifications.updateTemplateHandler', async () => {
    jest.spyOn(notificationService, 'updateTemplate').mockResolvedValue({ id: 't1' } as any);
    const { req, res, state } = rr({ params: { id: 't1' }, body: undefined });
    await notCtl.updateTemplateHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });
});

/* ========== auth.controller — exercise the logAction .catch() arrow ========== */

describe('auth.controller — logAction fire-and-forget catch arrows', () => {
  it('registerHandler: catch() arrow runs when logAction rejects', async () => {
    jest.spyOn(authService, 'register').mockResolvedValue({ id: 'u1', username: 'u' } as any);
    jest.spyOn(auditSvc, 'logAction').mockRejectedValue(new Error('audit broke'));
    const { req, res, state } = rr({ body: { username: 'u', password: 'p' } });
    await authCtl.registerHandler(req, res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(state.statusCode).toBe(201);
  });

  it('loginHandler: catch() arrow runs when logAction rejects', async () => {
    jest.spyOn(authService, 'login').mockResolvedValue({
      user: { id: 'u1' }, tokens: { accessToken: 'at', refreshToken: 'rt' },
    } as any);
    jest.spyOn(auditSvc, 'logAction').mockRejectedValue(new Error('audit broke'));
    const { req, res, state } = rr({ body: { username: 'u', password: 'p' } });
    await authCtl.loginHandler(req, res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(state.statusCode).toBe(200);
  });
});

/* ========== audit.service — maskSensitiveFields nested null ========== */

describe('audit.service — maskSensitiveFields recursion on null leaves', () => {
  it('masks sensitive fields nested deep even when siblings are null', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'a1', action: 'x',
        detail: {
          actorId: 'u1', resourceType: 'user', resourceId: 'u1',
          nullChild: null, // exercise the `value == null` inner branch
          deep: { passwordHash: 'SECRET', alsoNull: null },
        },
        traceId: null,
        createdAt: new Date('2026-01-01'),
      },
    ]);
    const csv = await auditSvc.exportAuditLogsCsv({});
    expect(csv).toContain('REDACTED');
    expect(csv).not.toContain('SECRET');
  });
});

/* ========== itinerary.service — travel time "no matrix entry" branches ========== */

describe('itinerary.service — travel matrix absent', () => {
  async function common() {
    const svc = await import('../src/services/itinerary.service');
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1' }) // ownership
      .mockResolvedValueOnce({ id: 't1', startDate: null }) // validateItem inner
      .mockResolvedValueOnce({ id: 't1', ownerId: 'u1', title: 'T', startDate: null, endDate: null, status: 'draft', destination: null }); // createVersion
    prisma.resource.findUnique.mockResolvedValue({ id: 'r1', minDwellMinutes: 10, hours: [], closures: [] });
    prisma.itineraryVersion.findFirst.mockResolvedValue(null);
    prisma.itineraryVersion.create.mockResolvedValue({});
    return svc;
  }

  it('next-item travel-time missing → passes', async () => {
    const svc = await common();
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([
        { id: 'nxt', dayNumber: 1, startTime: '12:00', endTime: '13:00', resourceId: 'r2', resource: {} },
      ])
      .mockResolvedValueOnce([]);
    prisma.travelTimeMatrix.findFirst.mockResolvedValue(null);
    prisma.itineraryItem.create.mockResolvedValue({ id: 'i-new', resource: {} });
    await svc.addItem('t1', 'u1', 'organizer', {
      resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00',
    });
    expect(prisma.itineraryItem.create).toHaveBeenCalled();
  });
});

/* ========== model.service — realpathSync catch + allowlist reject via Custom ========== */

describe('model.service — edge validation paths', () => {
  it('validateModelFilePath throws when realpathSync rejects', async () => {
    const { validateModelFilePath } = await import('../src/services/model.service');
    // A definitely-missing path makes realpathSync throw ENOENT.
    expect(() => validateModelFilePath('missing-file-absolutely.onnx', ['.onnx'])).toThrow();
  });

  it('safeEvaluateCondition matches each comparison operator branch', async () => {
    const { safeEvaluateCondition } = await import('../src/services/model.service');
    expect(safeEvaluateCondition('input.n > 5', { n: 10 })).toBe(true);
    expect(safeEvaluateCondition('input.n < 5', { n: 10 })).toBe(false);
    expect(safeEvaluateCondition('input.n >= 10', { n: 10 })).toBe(true);
    expect(safeEvaluateCondition('input.n <= 10', { n: 10 })).toBe(true);
    expect(safeEvaluateCondition('input.s === "hi"', { s: 'hi' })).toBe(true);
    expect(safeEvaluateCondition('input.s !== "hi"', { s: 'no' })).toBe(true);
    expect(safeEvaluateCondition('input.b === true', { b: true })).toBe(true);
    expect(safeEvaluateCondition('input.b === false', { b: false })).toBe(true);
  });
});

// auth.service line 160 is a defensive safeguard that's structurally
// unreachable under normal flow — the auto-unlock branch at 110-116 zeroes
// both status and lockedUntil before the success branch runs. Already
// documented in last_branches.spec.ts.

/* ========== routing.service — empty resourceIds + dedup filter ========== */

describe('routing.service — dedup trims duplicate arrangements', () => {
  it('symmetric travel times with 3 items produce deduped candidate list', async () => {
    const { optimizeItinerary } = await import('../src/services/routing.service');
    prisma.itinerary.findUnique.mockResolvedValue({ id: 't1', ownerId: 'u1' });
    prisma.itineraryItem.findMany.mockResolvedValue([
      { id: 'i1', resourceId: 'r1', dayNumber: 1, startTime: '10:00', endTime: '11:00', notes: null, position: 0, resource: { id: 'r1', name: 'A', city: 'X', region: 'Y' } },
      { id: 'i2', resourceId: 'r2', dayNumber: 1, startTime: '11:00', endTime: '12:00', notes: null, position: 1, resource: { id: 'r2', name: 'B', city: 'X', region: 'Y' } },
      { id: 'i3', resourceId: 'r3', dayNumber: 1, startTime: '12:00', endTime: '13:00', notes: null, position: 2, resource: { id: 'r3', name: 'C', city: 'X', region: 'Y' } },
    ]);
    // Uniform travel — every arrangement has the same cost, forcing the
    // dedup filter to trim.
    prisma.travelTimeMatrix.findMany.mockResolvedValue([
      { fromResourceId: 'r1', toResourceId: 'r2', travelMinutes: 10 },
      { fromResourceId: 'r2', toResourceId: 'r1', travelMinutes: 10 },
      { fromResourceId: 'r1', toResourceId: 'r3', travelMinutes: 10 },
      { fromResourceId: 'r3', toResourceId: 'r1', travelMinutes: 10 },
      { fromResourceId: 'r2', toResourceId: 'r3', travelMinutes: 10 },
      { fromResourceId: 'r3', toResourceId: 'r2', travelMinutes: 10 },
    ]);
    const suggestions = await optimizeItinerary('t1', 'u1', 'organizer');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});
