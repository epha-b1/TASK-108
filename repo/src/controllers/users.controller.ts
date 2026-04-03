import { Request, Response, NextFunction } from 'express';
import { getPrisma } from '../config/database';
import { AppError, NOT_FOUND, FORBIDDEN, VALIDATION_ERROR } from '../utils/errors';

export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const prisma = getPrisma();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take: limit,
        select: { id: true, username: true, role: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count(),
    ]);

    res.json({ data: users, page, limit, total });
  } catch (err) {
    next(err);
  }
}

export async function getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Non-admin can only fetch own profile
    if (req.user!.role !== 'admin' && req.user!.userId !== req.params.id) {
      throw new AppError(403, FORBIDDEN, 'Access denied');
    }

    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: req.params.id as string },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
        userRoles: { include: { role: true } },
      },
    });

    if (!user) {
      throw new AppError(404, NOT_FOUND, 'User not found');
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const prisma = getPrisma();
    const { status } = req.body;

    if (status && !['active', 'suspended', 'locked'].includes(status)) {
      throw new AppError(400, VALIDATION_ERROR, 'Invalid status. Must be active, suspended, or locked');
    }

    const user = await prisma.user.findUnique({ where: { id: req.params.id as string } });
    if (!user) {
      throw new AppError(404, NOT_FOUND, 'User not found');
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id as string },
      data: { status },
      select: { id: true, username: true, role: true, status: true },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: req.params.id as string } });
    if (!user) {
      throw new AppError(404, NOT_FOUND, 'User not found');
    }

    // Clean up related records
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.device.deleteMany({ where: { userId: user.id } });
    await prisma.securityQuestion.deleteMany({ where: { userId: user.id } });
    await prisma.passwordHistory.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
