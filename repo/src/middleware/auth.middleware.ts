import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/auth.service';
import { getUserPermissions } from '../services/rbac.service';
import { getPrisma } from '../config/database';
import { AppError, UNAUTHORIZED, FORBIDDEN } from '../utils/errors';
import { JwtPayload } from '../types/auth.types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      permissions?: string[];
      /**
       * Set of role names assigned to the request actor via `user_roles`.
       * This is the canonical source for role checks — `req.user.role` is
       * a derived convenience field, kept for backwards compatibility.
       */
      roleNames?: Set<string>;
    }
  }
}

/**
 * Resolve the effective role set for a user from the canonical RBAC tables.
 *
 * Historically `users.role` was the only source of truth, but the RBAC
 * APIs (`POST /users/:id/roles`, `POST /roles/:id/permissions`, ...) only
 * mutate `user_roles` / `role_permission_points`. That meant a freshly
 * promoted admin still appeared as `organizer` to the auth middleware
 * because `users.role` was never written. The audit flagged that drift.
 *
 * We now read `user_roles` first. The legacy `users.role` column still
 * participates as a fallback so:
 *   1. Seed accounts that only set `users.role` keep working.
 *   2. JWTs minted before this migration still authenticate.
 *
 * Exported for unit-testability.
 */
export async function resolveEffectiveRoles(userId: string, legacyRole: string | null | undefined): Promise<Set<string>> {
  const prisma = getPrisma();
  const memberships = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });

  const roles = new Set<string>();
  for (const m of memberships) {
    if (m.role?.name) roles.add(m.role.name);
  }
  // Legacy fallback — only contributes when user_roles is empty so a stale
  // `users.role='organizer'` cannot mask a real RBAC admin assignment.
  if (roles.size === 0 && legacyRole) {
    roles.add(legacyRole);
  }
  return roles;
}

/**
 * Pick the highest-privilege role name to expose as `req.user.role` for
 * backwards-compatible code paths that still expect a single string. Admin
 * always wins; otherwise we return any one role name; if there are none we
 * fall back to 'organizer' so downstream code that expects a non-empty
 * value doesn't crash.
 */
function pickPrimaryRole(roles: Set<string>): JwtPayload['role'] {
  if (roles.has('admin')) return 'admin';
  // Any non-admin membership collapses to 'organizer' for the JWT-payload
  // shape; permission point checks (the canonical authz path) carry the
  // real fine-grained authority through `req.permissions`.
  return 'organizer';
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError(401, UNAUTHORIZED, 'Authentication required'));
    return;
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);

    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });

    if (!user) {
      next(new AppError(401, UNAUTHORIZED, 'User not found'));
      return;
    }

    if (user.status !== 'active') {
      next(new AppError(403, FORBIDDEN, 'Account is not active'));
      return;
    }

    // Canonical role source = user_roles (RBAC). The legacy `users.role`
    // column only contributes when no membership row exists, so a freshly
    // promoted admin starts being treated as admin immediately, and a
    // role revocation via DELETE is honoured on the next request.
    const roleNames = await resolveEffectiveRoles(user.id, user.role);
    const primaryRole = pickPrimaryRole(roleNames);

    req.user = { ...payload, role: primaryRole };
    req.roleNames = roleNames;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, UNAUTHORIZED, 'Authentication required'));
      return;
    }

    // Canonical check: every role assignment in req.roleNames (populated by
    // authMiddleware from `user_roles`). The legacy single-string
    // `req.user.role` is still consulted as a fallback so callers minted
    // before authMiddleware ran (e.g. some unit tests that stub req.user
    // manually) keep working.
    const actorRoles = req.roleNames ?? new Set<string>([req.user.role]);
    const allowed = roles.some((r) => actorRoles.has(r));
    if (!allowed) {
      next(new AppError(403, FORBIDDEN, 'Insufficient role'));
      return;
    }

    next();
  };
}

export function requirePermission(code: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      next(new AppError(401, UNAUTHORIZED, 'Authentication required'));
      return;
    }

    try {
      // Admin bypasses permission point checks. We read from req.roleNames
      // (canonical RBAC set) first, with the legacy single-string role as
      // a defensive fallback.
      const actorRoles = req.roleNames ?? new Set<string>([req.user.role]);
      if (actorRoles.has('admin')) {
        next();
        return;
      }

      if (!req.permissions) {
        req.permissions = await getUserPermissions(req.user.userId);
      }

      if (!req.permissions.includes(code)) {
        next(new AppError(403, FORBIDDEN, `Missing permission: ${code}`));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
