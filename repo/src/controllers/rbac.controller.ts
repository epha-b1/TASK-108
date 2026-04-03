import { Request, Response, NextFunction } from 'express';
import * as rbacService from '../services/rbac.service';
import { logAction } from '../services/audit.service';
import { getTraceId } from '../utils/logger';

export async function createRoleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description } = req.body;
    const role = await rbacService.createRole(name, description);
    logAction(req.user!.userId, 'role.create', 'role', role.id, { name }, getTraceId()).catch(() => {});
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
}

export async function listRolesHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const roles = await rbacService.listRoles();
    res.json(roles);
  } catch (err) {
    next(err);
  }
}

export async function assignPermissionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { permissionPointIds } = req.body;
    const role = await rbacService.assignPermissionsToRole(req.params.id as string, permissionPointIds);
    logAction(req.user!.userId, 'role.assign_permissions', 'role', req.params.id as string, { permissionPointIds }, getTraceId()).catch(() => {});
    res.json(role);
  } catch (err) {
    next(err);
  }
}

export async function createPermissionPointHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code, description } = req.body;
    const pp = await rbacService.createPermissionPoint(code, description);
    res.status(201).json(pp);
  } catch (err) {
    next(err);
  }
}

export async function listPermissionPointsHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const points = await rbacService.listPermissionPoints();
    res.json(points);
  } catch (err) {
    next(err);
  }
}

export async function createMenuHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description, permissionPointIds } = req.body;
    const menu = await rbacService.createMenu(name, description, permissionPointIds);
    res.status(201).json(menu);
  } catch (err) {
    next(err);
  }
}

export async function listMenusHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const menus = await rbacService.listMenus();
    res.json(menus);
  } catch (err) {
    next(err);
  }
}

export async function assignRolesToUserHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { roleIds } = req.body;
    const result = await rbacService.assignRolesToUser(req.params.id as string, roleIds);
    logAction(req.user!.userId, 'user.assign_roles', 'user', req.params.id as string, { roleIds }, getTraceId()).catch(() => {});
    res.json(result);
  } catch (err) {
    next(err);
  }
}
