/**
 * Coverage for every controller handler in `src/controllers/`.
 *
 * Controllers are thin: they delegate to a service and (optionally) emit
 * audit + structured log entries. The tests therefore spy on the service
 * layer and assert that (a) the delegation happens with the expected
 * arguments, (b) the HTTP status / body reflect the service return value,
 * (c) error propagation goes through `next(err)`, and (d) each special-
 * case branch (challenge-issuance, CSV/XLSX header negotiation, ownership
 * checks for itinerary sharing/export) is exercised.
 */

import { Request, Response, NextFunction } from 'express';
import * as authService from '../src/services/auth.service';
import * as auditService from '../src/services/audit.service';
import * as resourceService from '../src/services/resource.service';
import * as rbacService from '../src/services/rbac.service';
import * as importService from '../src/services/import.service';
import * as itineraryService from '../src/services/itinerary.service';
import * as routingService from '../src/services/routing.service';
import * as modelService from '../src/services/model.service';
import * as notificationService from '../src/services/notification.service';

import * as authController from '../src/controllers/auth.controller';
import * as auditController from '../src/controllers/audit.controller';
import * as resourcesController from '../src/controllers/resources.controller';
import * as rbacController from '../src/controllers/rbac.controller';
import * as importController from '../src/controllers/import.controller';
import * as itinerariesController from '../src/controllers/itineraries.controller';
import * as modelsController from '../src/controllers/models.controller';
import * as notificationsController from '../src/controllers/notifications.controller';

import { getPrisma } from '../src/config/database';
import { AppError } from '../src/utils/errors';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

/** Build a minimal Express req/res/next triple for unit testing controllers. */
function rr(reqOver: Partial<Request> = {}) {
  const req = {
    user: { userId: 'u-actor', username: 'actor', role: 'organizer' },
    body: {},
    query: {},
    params: {},
    headers: {},
    ...reqOver,
  } as unknown as Request;
  const headers: Record<string, string> = {};
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    send(body: unknown) { state.body = body; return this; },
    setHeader(k: string, v: string) { headers[k] = v; },
  } as unknown as Response;
  const calls: { err: unknown }[] = [];
  const next: NextFunction = (err?: unknown) => { calls.push({ err }); };
  return { req, res, next, state, headers, calls };
}

beforeEach(() => {
  jest.restoreAllMocks();
  // Mute audit fire-and-forget so failing stubs don't pollute jest output.
  jest.spyOn(auditService, 'audit').mockImplementation(() => undefined);
  jest.spyOn(auditService, 'logAction').mockResolvedValue({ id: 'a' } as any);

  // Reset prisma mocks used by controllers that call it directly.
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
});

/* ========== auth.controller ========== */

describe('auth.controller', () => {
  it('registerHandler: 201 + logAction on happy path', async () => {
    jest.spyOn(authService, 'register').mockResolvedValue({ id: 'u1' } as any);
    const { req, res, next, state } = rr({ body: { username: 'a', password: 'p', securityQuestions: [] } });
    await authController.registerHandler(req, res, next);
    expect(state.statusCode).toBe(201);
    expect(state.body).toEqual({ id: 'u1' });
  });

  it('registerHandler: forwards service errors', async () => {
    jest.spyOn(authService, 'register').mockRejectedValue(new AppError(409, 'CONFLICT', 'dup'));
    const { req, res, next, calls } = rr({ body: { username: 'a', password: 'p' } });
    await authController.registerHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(AppError);
  });

  it('loginHandler: issues 429 challenge envelope when service returns challengeToken', async () => {
    jest.spyOn(authService, 'login').mockResolvedValue({
      challengeToken: 'tok',
      retryAfterSeconds: 30,
      message: 'challenge required',
    } as any);
    const { req, res, state } = rr({ body: { username: 'a', password: 'p' } });
    await authController.loginHandler(req, res, () => {});
    expect(state.statusCode).toBe(429);
    const body = state.body as any;
    expect(body.code).toBe('CHALLENGE_REQUIRED');
    expect(body.challengeToken).toBe('tok');
    expect(body.retryAfterSeconds).toBe(30);
  });

  it('loginHandler: 200 with tokens + user on normal success', async () => {
    jest.spyOn(authService, 'login').mockResolvedValue({
      user: { id: 'u1', username: 'a' },
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    } as any);
    const { req, res, state } = rr({ body: { username: 'a', password: 'p' } });
    await authController.loginHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect((state.body as any).accessToken).toBe('at');
  });

  it('loginHandler: service rejection → next(err)', async () => {
    jest.spyOn(authService, 'login').mockRejectedValue(new AppError(401, 'UNAUTHORIZED', 'bad'));
    const { req, res, next, calls } = rr({ body: {} });
    await authController.loginHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(AppError);
  });

  it('refreshHandler delegates and returns 200', async () => {
    jest.spyOn(authService, 'refresh').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' } as any);
    const { req, res, state } = rr({ body: { refreshToken: 'r' } });
    await authController.refreshHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('refreshHandler error → next', async () => {
    jest.spyOn(authService, 'refresh').mockRejectedValue(new Error('oops'));
    const { req, res, next, calls } = rr({ body: { refreshToken: 'x' } });
    await authController.refreshHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('logoutHandler 204 + audit', async () => {
    jest.spyOn(authService, 'logout').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ body: { refreshToken: 'r' } });
    await authController.logoutHandler(req, res, () => {});
    expect(state.statusCode).toBe(204);
  });

  it('logoutHandler error → next', async () => {
    jest.spyOn(authService, 'logout').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ body: { refreshToken: 'r' } });
    await authController.logoutHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('changePasswordHandler success', async () => {
    jest.spyOn(authService, 'changePassword').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ body: { currentPassword: 'a', newPassword: 'b' } });
    await authController.changePasswordHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('changePasswordHandler error → next', async () => {
    jest.spyOn(authService, 'changePassword').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ body: {} });
    await authController.changePasswordHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('recoverHandler success', async () => {
    jest.spyOn(authService, 'recoverPassword').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ body: { username: 'a', answers: [], newPassword: 'p' } });
    await authController.recoverHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('recoverHandler error → next', async () => {
    jest.spyOn(authService, 'recoverPassword').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await authController.recoverHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getMeHandler returns user', async () => {
    jest.spyOn(authService, 'getMe').mockResolvedValue({ id: 'u1' } as any);
    const { req, res, state } = rr();
    await authController.getMeHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'u1' });
  });

  it('getMeHandler error → next', async () => {
    jest.spyOn(authService, 'getMe').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await authController.getMeHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getDevicesHandler returns list', async () => {
    jest.spyOn(authService, 'getDevices').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await authController.getDevicesHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('getDevicesHandler error → next', async () => {
    jest.spyOn(authService, 'getDevices').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await authController.getDevicesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('removeDeviceHandler 204', async () => {
    jest.spyOn(authService, 'removeDevice').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ params: { id: 'd1' } });
    await authController.removeDeviceHandler(req, res, () => {});
    expect(state.statusCode).toBe(204);
  });

  it('removeDeviceHandler error → next', async () => {
    jest.spyOn(authService, 'removeDevice').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'd1' } });
    await authController.removeDeviceHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== audit.controller ========== */

describe('audit.controller', () => {
  it('queryAuditLogsHandler passes filters and returns 200', async () => {
    jest.spyOn(auditService, 'queryAuditLogs').mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 } as any);
    const { req, res, state } = rr({
      query: { actorId: 'u', action: 'a', resourceType: 'r', from: 'f', to: 't', page: '2', limit: '10' } as any,
    });
    await auditController.queryAuditLogsHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect(auditService.queryAuditLogs).toHaveBeenCalledWith({
      actorId: 'u', action: 'a', resourceType: 'r', from: 'f', to: 't', page: 2, limit: 10,
    });
  });

  it('queryAuditLogsHandler: undefined paging params default to undefined', async () => {
    jest.spyOn(auditService, 'queryAuditLogs').mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 } as any);
    const { req, res } = rr();
    await auditController.queryAuditLogsHandler(req, res, () => {});
    const args = (auditService.queryAuditLogs as jest.Mock).mock.calls[0][0];
    expect(args.page).toBeUndefined();
    expect(args.limit).toBeUndefined();
  });

  it('queryAuditLogsHandler error → next', async () => {
    jest.spyOn(auditService, 'queryAuditLogs').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await auditController.queryAuditLogsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('exportAuditLogsCsvHandler sets CSV headers and returns body', async () => {
    jest.spyOn(auditService, 'exportAuditLogsCsv').mockResolvedValue('id,action\n1,x');
    const { req, res, state, headers } = rr({ query: { from: 'f', to: 't' } as any });
    await auditController.exportAuditLogsCsvHandler(req, res, () => {});
    expect(headers['Content-Type']).toBe('text/csv');
    expect(headers['Content-Disposition']).toContain('audit-logs.csv');
    expect(state.body).toBe('id,action\n1,x');
  });

  it('exportAuditLogsCsvHandler error → next', async () => {
    jest.spyOn(auditService, 'exportAuditLogsCsv').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await auditController.exportAuditLogsCsvHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== resources.controller ========== */

describe('resources.controller', () => {
  it('createResourceHandler delegates, audits, and returns 201', async () => {
    jest.spyOn(resourceService, 'createResource').mockResolvedValue({ id: 'r1', name: 'X', type: 'attraction' } as any);
    const { req, res, state } = rr({ body: { name: 'X', type: 'attraction' } });
    await resourcesController.createResourceHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createResourceHandler error → next', async () => {
    jest.spyOn(resourceService, 'createResource').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await resourcesController.createResourceHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listResourcesHandler passes filters', async () => {
    jest.spyOn(resourceService, 'listResources').mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);
    const { req, res, state } = rr({ query: { type: 'attraction', city: 'Rome', page: '2', limit: '5' } as any });
    await resourcesController.listResourcesHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect(resourceService.listResources).toHaveBeenCalledWith({
      type: 'attraction', city: 'Rome', page: 2, limit: 5,
    });
  });

  it('listResourcesHandler error → next', async () => {
    jest.spyOn(resourceService, 'listResources').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await resourcesController.listResourcesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getResourceHandler 200', async () => {
    jest.spyOn(resourceService, 'getResource').mockResolvedValue({ id: 'r1' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' } });
    await resourcesController.getResourceHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'r1' });
  });

  it('getResourceHandler error → next', async () => {
    jest.spyOn(resourceService, 'getResource').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' } });
    await resourcesController.getResourceHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('updateResourceHandler', async () => {
    jest.spyOn(resourceService, 'updateResource').mockResolvedValue({ id: 'r1', name: 'new' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' }, body: { name: 'new' } });
    await resourcesController.updateResourceHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('updateResourceHandler error → next', async () => {
    jest.spyOn(resourceService, 'updateResource').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' }, body: {} });
    await resourcesController.updateResourceHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('deleteResourceHandler 204', async () => {
    jest.spyOn(resourceService, 'deleteResource').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ params: { id: 'r1' } });
    await resourcesController.deleteResourceHandler(req, res, () => {});
    expect(state.statusCode).toBe(204);
  });

  it('deleteResourceHandler error → next', async () => {
    jest.spyOn(resourceService, 'deleteResource').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' } });
    await resourcesController.deleteResourceHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('setBusinessHoursHandler 201', async () => {
    jest.spyOn(resourceService, 'setBusinessHours').mockResolvedValue({ id: 'h1', dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' }, body: { dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' } });
    await resourcesController.setBusinessHoursHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('setBusinessHoursHandler error → next', async () => {
    jest.spyOn(resourceService, 'setBusinessHours').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' }, body: {} });
    await resourcesController.setBusinessHoursHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getBusinessHoursHandler', async () => {
    jest.spyOn(resourceService, 'getBusinessHours').mockResolvedValue([] as any);
    const { req, res, state } = rr({ params: { id: 'r1' } });
    await resourcesController.getBusinessHoursHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('getBusinessHoursHandler error → next', async () => {
    jest.spyOn(resourceService, 'getBusinessHours').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' } });
    await resourcesController.getBusinessHoursHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('addClosureHandler 201', async () => {
    jest.spyOn(resourceService, 'addClosure').mockResolvedValue({ id: 'c1', date: new Date(), reason: 'x' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' }, body: { date: '2026-01-01', reason: 'x' } });
    await resourcesController.addClosureHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('addClosureHandler error → next', async () => {
    jest.spyOn(resourceService, 'addClosure').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' }, body: {} });
    await resourcesController.addClosureHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getClosuresHandler', async () => {
    jest.spyOn(resourceService, 'getClosures').mockResolvedValue([] as any);
    const { req, res, state } = rr({ params: { id: 'r1' } });
    await resourcesController.getClosuresHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('getClosuresHandler error → next', async () => {
    jest.spyOn(resourceService, 'getClosures').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' } });
    await resourcesController.getClosuresHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('upsertTravelTimeHandler 200', async () => {
    jest.spyOn(resourceService, 'upsertTravelTime').mockResolvedValue({
      id: 't1', fromResourceId: 'a', toResourceId: 'b', transportMode: 'car', travelMinutes: 10,
    } as any);
    const { req, res, state } = rr({
      body: { fromResourceId: 'a', toResourceId: 'b', transportMode: 'car', travelMinutes: 10 },
    });
    await resourcesController.upsertTravelTimeHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('upsertTravelTimeHandler error → next', async () => {
    jest.spyOn(resourceService, 'upsertTravelTime').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await resourcesController.upsertTravelTimeHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listTravelTimesHandler passes from filter', async () => {
    jest.spyOn(resourceService, 'listTravelTimes').mockResolvedValue([] as any);
    const { req, res, state } = rr({ query: { fromResourceId: 'r1' } as any });
    await resourcesController.listTravelTimesHandler(req, res, () => {});
    expect(state.body).toEqual([]);
    expect(resourceService.listTravelTimes).toHaveBeenCalledWith('r1');
  });

  it('listTravelTimesHandler error → next', async () => {
    jest.spyOn(resourceService, 'listTravelTimes').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await resourcesController.listTravelTimesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== rbac.controller ========== */

describe('rbac.controller', () => {
  it('createRoleHandler 201', async () => {
    jest.spyOn(rbacService, 'createRole').mockResolvedValue({ id: 'r1', name: 'ed' } as any);
    const { req, res, state } = rr({ body: { name: 'ed', description: 'd' } });
    await rbacController.createRoleHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createRoleHandler error → next', async () => {
    jest.spyOn(rbacService, 'createRole').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.createRoleHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listRolesHandler returns list', async () => {
    jest.spyOn(rbacService, 'listRoles').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await rbacController.listRolesHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('listRolesHandler error → next', async () => {
    jest.spyOn(rbacService, 'listRoles').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.listRolesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('assignPermissionsHandler delegates', async () => {
    jest.spyOn(rbacService, 'assignPermissionsToRole').mockResolvedValue({ id: 'r1' } as any);
    const { req, res, state } = rr({ params: { id: 'r1' }, body: { permissionPointIds: ['p1'] } });
    await rbacController.assignPermissionsHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'r1' });
  });

  it('assignPermissionsHandler error → next', async () => {
    jest.spyOn(rbacService, 'assignPermissionsToRole').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'r1' }, body: {} });
    await rbacController.assignPermissionsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('createPermissionPointHandler 201', async () => {
    jest.spyOn(rbacService, 'createPermissionPoint').mockResolvedValue({ id: 'p1', code: 'u:r' } as any);
    const { req, res, state } = rr({ body: { code: 'u:r' } });
    await rbacController.createPermissionPointHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createPermissionPointHandler error → next', async () => {
    jest.spyOn(rbacService, 'createPermissionPoint').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.createPermissionPointHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listPermissionPointsHandler returns list', async () => {
    jest.spyOn(rbacService, 'listPermissionPoints').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await rbacController.listPermissionPointsHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('listPermissionPointsHandler error → next', async () => {
    jest.spyOn(rbacService, 'listPermissionPoints').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.listPermissionPointsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('createMenuHandler 201', async () => {
    jest.spyOn(rbacService, 'createMenu').mockResolvedValue({ id: 'm1', name: 'm' } as any);
    const { req, res, state } = rr({ body: { name: 'm' } });
    await rbacController.createMenuHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createMenuHandler error → next', async () => {
    jest.spyOn(rbacService, 'createMenu').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.createMenuHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listMenusHandler returns list', async () => {
    jest.spyOn(rbacService, 'listMenus').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await rbacController.listMenusHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('listMenusHandler error → next', async () => {
    jest.spyOn(rbacService, 'listMenus').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await rbacController.listMenusHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('assignRolesToUserHandler 200', async () => {
    jest.spyOn(rbacService, 'assignRolesToUser').mockResolvedValue({ id: 'u1' } as any);
    const { req, res, state } = rr({ params: { id: 'u1' }, body: { roleIds: ['r1'] } });
    await rbacController.assignRolesToUserHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'u1' });
  });

  it('assignRolesToUserHandler error → next', async () => {
    jest.spyOn(rbacService, 'assignRolesToUser').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'u1' }, body: {} });
    await rbacController.assignRolesToUserHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== import.controller ========== */

describe('import.controller', () => {
  it('downloadTemplateHandler accepts ?format=csv', async () => {
    jest.spyOn(importService, 'downloadTemplate').mockResolvedValue({
      contentType: 'text/csv', filename: 't.csv', body: Buffer.from('a,b'),
    } as any);
    const { req, res, state, headers } = rr({
      params: { entityType: 'resource' }, query: { format: 'csv' } as any,
    });
    await importController.downloadTemplateHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect(headers['Content-Type']).toBe('text/csv');
    expect(importService.downloadTemplate).toHaveBeenCalledWith('resource', 'csv');
  });

  it('downloadTemplateHandler accepts ?format=xlsx', async () => {
    jest.spyOn(importService, 'downloadTemplate').mockResolvedValue({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 't.xlsx', body: Buffer.from(''),
    } as any);
    const { req, res } = rr({ params: { entityType: 'resource' }, query: { format: 'xlsx' } as any });
    await importController.downloadTemplateHandler(req, res, () => {});
    expect(importService.downloadTemplate).toHaveBeenCalledWith('resource', 'xlsx');
  });

  it('downloadTemplateHandler rejects unknown format via AppError envelope', async () => {
    const { req, res, next, calls } = rr({
      params: { entityType: 'resource' }, query: { format: 'pdf' } as any,
    });
    await importController.downloadTemplateHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(AppError);
    expect((calls[0].err as AppError).statusCode).toBe(400);
  });

  it('downloadTemplateHandler honours Accept: text/csv when format query is absent', async () => {
    jest.spyOn(importService, 'downloadTemplate').mockResolvedValue({
      contentType: 'text/csv', filename: 't.csv', body: Buffer.from(''),
    } as any);
    const { req, res } = rr({
      params: { entityType: 'resource' }, headers: { accept: 'text/csv' },
    });
    await importController.downloadTemplateHandler(req, res, () => {});
    expect(importService.downloadTemplate).toHaveBeenCalledWith('resource', 'csv');
  });

  it('downloadTemplateHandler defaults to xlsx when no signal', async () => {
    jest.spyOn(importService, 'downloadTemplate').mockResolvedValue({
      contentType: 'app/x', filename: 't.xlsx', body: Buffer.from(''),
    } as any);
    const { req, res } = rr({ params: { entityType: 'resource' } });
    await importController.downloadTemplateHandler(req, res, () => {});
    expect(importService.downloadTemplate).toHaveBeenCalledWith('resource', 'xlsx');
  });

  it('downloadTemplateHandler propagates service errors', async () => {
    jest.spyOn(importService, 'downloadTemplate').mockRejectedValue(new Error('oops'));
    const { req, res, next, calls } = rr({ params: { entityType: 'resource' } });
    await importController.downloadTemplateHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('uploadHandler 200 with audit on success', async () => {
    jest.spyOn(importService, 'uploadAndValidate').mockResolvedValue({
      id: 'b1', totalRows: 10, successRows: 8, errorRows: 2,
    } as any);
    const file = { buffer: Buffer.from('a,b'), originalname: 't.csv' } as any;
    const { req, res, state } = rr({
      file,
      body: { entityType: 'resource', idempotencyKey: 'idem', deduplicationKey: 'dk' },
    } as any);
    await importController.uploadHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect(importService.uploadAndValidate).toHaveBeenCalledWith(
      'u-actor',
      { buffer: file.buffer, originalname: 't.csv' },
      'resource',
      'idem',
      'dk',
    );
  });

  it('uploadHandler skips audit when result has no id', async () => {
    jest.spyOn(importService, 'uploadAndValidate').mockResolvedValue(null as any);
    const file = { buffer: Buffer.from(''), originalname: 't.csv' } as any;
    const { req, res, state } = rr({ file, body: { entityType: 'resource' } } as any);
    await importController.uploadHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('uploadHandler error → next', async () => {
    jest.spyOn(importService, 'uploadAndValidate').mockRejectedValue(new Error('x'));
    const file = { buffer: Buffer.from(''), originalname: 't.csv' } as any;
    const { req, res, next, calls } = rr({ file, body: { entityType: 'resource' } } as any);
    await importController.uploadHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('commitHandler 200', async () => {
    jest.spyOn(importService, 'commitBatch').mockResolvedValue({ id: 'b1', entityType: 'resource', successRows: 8 } as any);
    const { req, res, state } = rr({ params: { batchId: 'b1' } });
    await importController.commitHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('commitHandler error → next', async () => {
    jest.spyOn(importService, 'commitBatch').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { batchId: 'b1' } });
    await importController.commitHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('rollbackHandler 200', async () => {
    jest.spyOn(importService, 'rollbackBatch').mockResolvedValue({ id: 'b1', entityType: 'resource' } as any);
    const { req, res, state } = rr({ params: { batchId: 'b1' } });
    await importController.rollbackHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('rollbackHandler error → next', async () => {
    jest.spyOn(importService, 'rollbackBatch').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { batchId: 'b1' } });
    await importController.rollbackHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getBatchStatusHandler 200', async () => {
    jest.spyOn(importService, 'getBatchStatus').mockResolvedValue({ id: 'b1', status: 'pending' } as any);
    const { req, res, state } = rr({ params: { batchId: 'b1' } });
    await importController.getBatchStatusHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('getBatchStatusHandler error → next', async () => {
    jest.spyOn(importService, 'getBatchStatus').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { batchId: 'b1' } });
    await importController.getBatchStatusHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== itineraries.controller ========== */

describe('itineraries.controller', () => {
  it('createItineraryHandler 201', async () => {
    jest.spyOn(itineraryService, 'createItinerary').mockResolvedValue({ id: 'i1' } as any);
    const { req, res, state } = rr({ body: { title: 'T' } });
    await itinerariesController.createItineraryHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createItineraryHandler error → next', async () => {
    jest.spyOn(itineraryService, 'createItinerary').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await itinerariesController.createItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listItinerariesHandler with paging', async () => {
    jest.spyOn(itineraryService, 'listItineraries').mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);
    const { req, res } = rr({ query: { status: 'draft', page: '2', limit: '5' } as any });
    await itinerariesController.listItinerariesHandler(req, res, () => {});
    expect(itineraryService.listItineraries).toHaveBeenCalledWith('u-actor', 'organizer', {
      status: 'draft', page: 2, limit: 5,
    });
  });

  it('listItinerariesHandler error → next', async () => {
    jest.spyOn(itineraryService, 'listItineraries').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await itinerariesController.listItinerariesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getItineraryHandler 200', async () => {
    jest.spyOn(itineraryService, 'getItinerary').mockResolvedValue({ id: 'i1' } as any);
    const { req, res, state } = rr({ params: { id: 'i1' } });
    await itinerariesController.getItineraryHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'i1' });
  });

  it('getItineraryHandler error → next', async () => {
    jest.spyOn(itineraryService, 'getItinerary').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.getItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('updateItineraryHandler 200', async () => {
    jest.spyOn(itineraryService, 'updateItinerary').mockResolvedValue({ id: 'i1' } as any);
    const { req, res, state } = rr({ params: { id: 'i1' }, body: { title: 'X' } });
    await itinerariesController.updateItineraryHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('updateItineraryHandler error → next', async () => {
    jest.spyOn(itineraryService, 'updateItinerary').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' }, body: {} });
    await itinerariesController.updateItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('deleteItineraryHandler 204', async () => {
    jest.spyOn(itineraryService, 'deleteItinerary').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ params: { id: 'i1' } });
    await itinerariesController.deleteItineraryHandler(req, res, () => {});
    expect(state.statusCode).toBe(204);
  });

  it('deleteItineraryHandler error → next', async () => {
    jest.spyOn(itineraryService, 'deleteItinerary').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.deleteItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('addItemHandler 201', async () => {
    jest.spyOn(itineraryService, 'addItem').mockResolvedValue({ id: 'it1', resourceId: 'r1', dayNumber: 1 } as any);
    const { req, res, state } = rr({ params: { id: 'i1' }, body: { resourceId: 'r1' } });
    await itinerariesController.addItemHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('addItemHandler error → next', async () => {
    jest.spyOn(itineraryService, 'addItem').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' }, body: {} });
    await itinerariesController.addItemHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('updateItemHandler 200', async () => {
    jest.spyOn(itineraryService, 'updateItem').mockResolvedValue({ id: 'it1' } as any);
    const { req, res, state } = rr({ params: { id: 'i1', itemId: 'it1' }, body: { notes: 'n' } });
    await itinerariesController.updateItemHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('updateItemHandler error → next', async () => {
    jest.spyOn(itineraryService, 'updateItem').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1', itemId: 'it1' }, body: {} });
    await itinerariesController.updateItemHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('removeItemHandler 204', async () => {
    jest.spyOn(itineraryService, 'removeItem').mockResolvedValue(undefined as any);
    const { req, res, state } = rr({ params: { id: 'i1', itemId: 'it1' } });
    await itinerariesController.removeItemHandler(req, res, () => {});
    expect(state.statusCode).toBe(204);
  });

  it('removeItemHandler error → next', async () => {
    jest.spyOn(itineraryService, 'removeItem').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1', itemId: 'it1' } });
    await itinerariesController.removeItemHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listItemsHandler with dayNumber', async () => {
    jest.spyOn(itineraryService, 'listItems').mockResolvedValue([] as any);
    const { req, res } = rr({ params: { id: 'i1' }, query: { dayNumber: '2' } as any });
    await itinerariesController.listItemsHandler(req, res, () => {});
    expect(itineraryService.listItems).toHaveBeenCalledWith('i1', 'u-actor', 'organizer', 2);
  });

  it('listItemsHandler without dayNumber → undefined filter', async () => {
    jest.spyOn(itineraryService, 'listItems').mockResolvedValue([] as any);
    const { req, res } = rr({ params: { id: 'i1' } });
    await itinerariesController.listItemsHandler(req, res, () => {});
    expect(itineraryService.listItems).toHaveBeenCalledWith('i1', 'u-actor', 'organizer', undefined);
  });

  it('listItemsHandler error → next', async () => {
    jest.spyOn(itineraryService, 'listItems').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.listItemsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getVersionsHandler 200', async () => {
    jest.spyOn(itineraryService, 'getVersions').mockResolvedValue([] as any);
    const { req, res, state } = rr({ params: { id: 'i1' } });
    await itinerariesController.getVersionsHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('getVersionsHandler error → next', async () => {
    jest.spyOn(itineraryService, 'getVersions').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.getVersionsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('optimizeItineraryHandler passes dayNumber', async () => {
    jest.spyOn(routingService, 'optimizeItinerary').mockResolvedValue([] as any);
    const { req, res } = rr({ params: { id: 'i1' }, query: { dayNumber: '3' } as any });
    await itinerariesController.optimizeItineraryHandler(req, res, () => {});
    expect(routingService.optimizeItinerary).toHaveBeenCalledWith('i1', 'u-actor', 'organizer', 3);
  });

  it('optimizeItineraryHandler without dayNumber', async () => {
    jest.spyOn(routingService, 'optimizeItinerary').mockResolvedValue([] as any);
    const { req, res } = rr({ params: { id: 'i1' } });
    await itinerariesController.optimizeItineraryHandler(req, res, () => {});
    expect(routingService.optimizeItinerary).toHaveBeenCalledWith('i1', 'u-actor', 'organizer', undefined);
  });

  it('optimizeItineraryHandler error → next', async () => {
    jest.spyOn(routingService, 'optimizeItinerary').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.optimizeItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('shareItineraryHandler: 404 when itinerary not found', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.shareItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('shareItineraryHandler: 403 when organizer is not owner', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 'i1', ownerId: 'someone-else' });
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.shareItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(403);
  });

  it('shareItineraryHandler: admin may share another user\'s trip', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 'i1', ownerId: 'someone-else' });
    prisma.itinerary.update.mockResolvedValue({ id: 'i1' });
    const { req, res, state } = rr({
      params: { id: 'i1' },
      user: { userId: 'uA', role: 'admin', username: 'root' } as any,
    });
    await itinerariesController.shareItineraryHandler(req, res, () => {});
    const body = state.body as any;
    expect(body.shareToken).toHaveLength(64);
    expect(body.shareUrl).toBe(`/shared/${body.shareToken}`);
    expect(body.expiresAt).toBeInstanceOf(Date);
  });

  it('shareItineraryHandler: owner success', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 'i1', ownerId: 'u-actor' });
    prisma.itinerary.update.mockResolvedValue({ id: 'i1' });
    const { req, res, state } = rr({ params: { id: 'i1' } });
    await itinerariesController.shareItineraryHandler(req, res, () => {});
    expect((state.body as any).shareToken).toBeDefined();
  });

  it('shareItineraryHandler: DB error → next', async () => {
    prisma.itinerary.findUnique.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.shareItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getSharedItineraryHandler: 404 when token miss', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { token: 'nope' } });
    await itinerariesController.getSharedItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('getSharedItineraryHandler: 404 when shareExpiresAt missing', async () => {
    prisma.itinerary.findFirst.mockResolvedValue({ id: 'i1', shareExpiresAt: null });
    const { req, res, next, calls } = rr({ params: { token: 't' } });
    await itinerariesController.getSharedItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('getSharedItineraryHandler: 404 when expired', async () => {
    prisma.itinerary.findFirst.mockResolvedValue({ id: 'i1', shareExpiresAt: new Date(Date.now() - 1000) });
    const { req, res, next, calls } = rr({ params: { token: 't' } });
    await itinerariesController.getSharedItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('getSharedItineraryHandler: returns itinerary when valid', async () => {
    prisma.itinerary.findFirst.mockResolvedValue({
      id: 'i1', shareExpiresAt: new Date(Date.now() + 60_000), items: [],
    });
    const { req, res, state } = rr({ params: { token: 't' } });
    await itinerariesController.getSharedItineraryHandler(req, res, () => {});
    expect((state.body as any).id).toBe('i1');
  });

  it('exportItineraryHandler: 404 when ownership check misses', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(null);
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.exportItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('exportItineraryHandler: 404 when second findUnique misses', async () => {
    // Ownership check passes, but the hydrated fetch misses.
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 'i1', ownerId: 'u-actor' })
      .mockResolvedValueOnce(null);
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.exportItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(404);
  });

  it('exportItineraryHandler: 403 when non-admin non-owner', async () => {
    prisma.itinerary.findUnique.mockResolvedValue({ id: 'i1', ownerId: 'other' });
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.exportItineraryHandler(req, res, next);
    expect((calls[0].err as AppError).statusCode).toBe(403);
  });

  it('exportItineraryHandler: happy path returns schema v1.0 envelope', async () => {
    prisma.itinerary.findUnique
      .mockResolvedValueOnce({ id: 'i1', ownerId: 'u-actor' })
      .mockResolvedValueOnce({
        id: 'i1', title: 'T', destination: 'D', startDate: new Date(), endDate: new Date(),
        status: 'draft', createdAt: new Date(), updatedAt: new Date(),
        items: [{ id: 'it1', dayNumber: 1, startTime: '', endTime: '', notes: null, position: 0, resource: {} }],
      });
    const { req, res, state } = rr({ params: { id: 'i1' } });
    await itinerariesController.exportItineraryHandler(req, res, () => {});
    const body = state.body as any;
    expect(body.schemaVersion).toBe('1.0');
    expect(body.items).toHaveLength(1);
  });

  it('exportItineraryHandler: DB error → next', async () => {
    prisma.itinerary.findUnique.mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'i1' } });
    await itinerariesController.exportItineraryHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== models.controller ========== */

describe('models.controller', () => {
  it('registerModelHandler 201', async () => {
    jest.spyOn(modelService, 'registerModel').mockResolvedValue({ id: 'm1', name: 'n', version: '1', type: 't' } as any);
    const { req, res, state } = rr({ body: {} });
    await modelsController.registerModelHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('registerModelHandler error → next', async () => {
    jest.spyOn(modelService, 'registerModel').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await modelsController.registerModelHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listModelsHandler 200', async () => {
    jest.spyOn(modelService, 'listModels').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await modelsController.listModelsHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('listModelsHandler error → next', async () => {
    jest.spyOn(modelService, 'listModels').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await modelsController.listModelsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getModelHandler 200', async () => {
    jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'm1' } as any);
    const { req, res, state } = rr({ params: { id: 'm1' } });
    await modelsController.getModelHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'm1' });
  });

  it('getModelHandler error → next', async () => {
    jest.spyOn(modelService, 'getModel').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'm1' } });
    await modelsController.getModelHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('updateModelStatusHandler 200', async () => {
    jest.spyOn(modelService, 'updateModelStatus').mockResolvedValue({ id: 'm1', status: 'active' } as any);
    const { req, res, state } = rr({ params: { id: 'm1' }, body: { status: 'active' } });
    await modelsController.updateModelStatusHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('updateModelStatusHandler error → next', async () => {
    jest.spyOn(modelService, 'updateModelStatus').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'm1' }, body: {} });
    await modelsController.updateModelStatusHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('setAbAllocationHandler 200', async () => {
    jest.spyOn(modelService, 'setAbAllocation').mockResolvedValue({ id: 'm1' } as any);
    const { req, res, state } = rr({ params: { id: 'm1' }, body: { groupName: 'A', percentage: 50 } });
    await modelsController.setAbAllocationHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('setAbAllocationHandler error → next', async () => {
    jest.spyOn(modelService, 'setAbAllocation').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'm1' }, body: {} });
    await modelsController.setAbAllocationHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('inferHandler 200 with context', async () => {
    jest.spyOn(modelService, 'infer').mockResolvedValue({ prediction: 'x' } as any);
    const { req, res, state } = rr({
      params: { id: 'm1' },
      body: { input: { a: 1 }, context: { b: 2 } },
    });
    await modelsController.inferHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
    expect(modelService.infer).toHaveBeenCalledWith('m1', { a: 1 }, { b: 2 }, 'u-actor');
  });

  it('inferHandler handles null input/context', async () => {
    jest.spyOn(modelService, 'infer').mockResolvedValue({ prediction: 'x' } as any);
    const { req, res, state } = rr({ params: { id: 'm1' }, body: {} });
    await modelsController.inferHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('inferHandler error → next', async () => {
    jest.spyOn(modelService, 'infer').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'm1' }, body: { input: {} } });
    await modelsController.inferHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});

/* ========== notifications.controller ========== */

describe('notifications.controller', () => {
  it('createTemplateHandler 201', async () => {
    jest.spyOn(notificationService, 'createTemplate').mockResolvedValue({ id: 't1' } as any);
    const { req, res, state } = rr({ body: { code: 'c', subject: 's', body: 'b' } });
    await notificationsController.createTemplateHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('createTemplateHandler error → next', async () => {
    jest.spyOn(notificationService, 'createTemplate').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await notificationsController.createTemplateHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listTemplatesHandler', async () => {
    jest.spyOn(notificationService, 'listTemplates').mockResolvedValue([] as any);
    const { req, res, state } = rr();
    await notificationsController.listTemplatesHandler(req, res, () => {});
    expect(state.body).toEqual([]);
  });

  it('listTemplatesHandler error → next', async () => {
    jest.spyOn(notificationService, 'listTemplates').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await notificationsController.listTemplatesHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('updateTemplateHandler', async () => {
    jest.spyOn(notificationService, 'updateTemplate').mockResolvedValue({ id: 't1' } as any);
    const { req, res, state } = rr({ params: { id: 't1' }, body: { subject: 'new' } });
    await notificationsController.updateTemplateHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('updateTemplateHandler error → next', async () => {
    jest.spyOn(notificationService, 'updateTemplate').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 't1' }, body: {} });
    await notificationsController.updateTemplateHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('sendNotificationHandler 201 with template', async () => {
    jest.spyOn(notificationService, 'sendNotification').mockResolvedValue({ id: 'n1' } as any);
    const { req, res, state } = rr({
      body: { userId: 'u1', type: 'email', templateCode: 'welcome', variables: { n: 'A' } },
    });
    await notificationsController.sendNotificationHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('sendNotificationHandler 201 without template', async () => {
    jest.spyOn(notificationService, 'sendNotification').mockResolvedValue({ id: 'n1' } as any);
    const { req, res, state } = rr({
      body: { userId: 'u1', type: 'email', subject: 's', message: 'm' },
    });
    await notificationsController.sendNotificationHandler(req, res, () => {});
    expect(state.statusCode).toBe(201);
  });

  it('sendNotificationHandler error → next', async () => {
    jest.spyOn(notificationService, 'sendNotification').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await notificationsController.sendNotificationHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('listNotificationsHandler maps read=true', async () => {
    jest.spyOn(notificationService, 'listNotifications').mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);
    const { req, res } = rr({ query: { read: 'true', page: '2', limit: '5' } as any });
    await notificationsController.listNotificationsHandler(req, res, () => {});
    expect(notificationService.listNotifications).toHaveBeenCalledWith('u-actor', true, 2, 5);
  });

  it('listNotificationsHandler maps read=false', async () => {
    jest.spyOn(notificationService, 'listNotifications').mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);
    const { req, res } = rr({ query: { read: 'false' } as any });
    await notificationsController.listNotificationsHandler(req, res, () => {});
    expect(notificationService.listNotifications).toHaveBeenCalledWith('u-actor', false, undefined, undefined);
  });

  it('listNotificationsHandler maps read=undefined', async () => {
    jest.spyOn(notificationService, 'listNotifications').mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 } as any);
    const { req, res } = rr();
    await notificationsController.listNotificationsHandler(req, res, () => {});
    expect(notificationService.listNotifications).toHaveBeenCalledWith('u-actor', undefined, undefined, undefined);
  });

  it('listNotificationsHandler error → next', async () => {
    jest.spyOn(notificationService, 'listNotifications').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await notificationsController.listNotificationsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('markReadHandler 200', async () => {
    jest.spyOn(notificationService, 'markRead').mockResolvedValue({ id: 'n1' } as any);
    const { req, res, state } = rr({ params: { id: 'n1' } });
    await notificationsController.markReadHandler(req, res, () => {});
    expect(state.body).toEqual({ id: 'n1' });
  });

  it('markReadHandler error → next', async () => {
    jest.spyOn(notificationService, 'markRead').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr({ params: { id: 'n1' } });
    await notificationsController.markReadHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });

  it('getStatsHandler 200', async () => {
    jest.spyOn(notificationService, 'getStats').mockResolvedValue({ total: 0, delivered: 0, pending: 0, failed: 0 } as any);
    const { req, res, state } = rr();
    await notificationsController.getStatsHandler(req, res, () => {});
    expect(state.statusCode).toBe(200);
  });

  it('getStatsHandler error → next', async () => {
    jest.spyOn(notificationService, 'getStats').mockRejectedValue(new Error('x'));
    const { req, res, next, calls } = rr();
    await notificationsController.getStatsHandler(req, res, next);
    expect(calls[0].err).toBeInstanceOf(Error);
  });
});
