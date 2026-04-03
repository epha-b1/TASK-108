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
    }
  }
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

    req.user = { ...payload, role: user.role as JwtPayload['role'] };
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

    if (!roles.includes(req.user.role)) {
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
      // Admin role bypasses permission checks
      if (req.user.role === 'admin') {
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
