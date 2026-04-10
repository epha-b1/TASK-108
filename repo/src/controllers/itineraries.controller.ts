import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import * as itineraryService from '../services/itinerary.service';
import * as routingService from '../services/routing.service';
import { getPrisma } from '../config/database';
import { AppError, NOT_FOUND, FORBIDDEN } from '../utils/errors';
import { audit } from '../services/audit.service';
import { itineraryLog } from '../utils/logger';

async function enforceOwnership(itineraryId: string, userId: string, role: string) {
  const prisma = getPrisma();
  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary) throw new AppError(404, NOT_FOUND, 'Itinerary not found');
  if (role !== 'admin' && itinerary.ownerId !== userId) throw new AppError(403, FORBIDDEN, 'Access denied');
  return itinerary;
}

export async function createItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.createItinerary(req.user!.userId, req.body);
    audit(req, 'itinerary.create', 'itinerary', result.id, { title: req.body.title });
    itineraryLog.info('itinerary.create', { itineraryId: result.id, ownerId: req.user!.userId });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listItinerariesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, page, limit } = req.query;
    const result = await itineraryService.listItineraries(req.user!.userId, req.user!.role, {
      status: status as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.getItinerary(req.params.id as string, req.user!.userId, req.user!.role);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.updateItinerary(req.params.id as string, req.user!.userId, req.user!.role, req.body);
    audit(req, 'itinerary.update', 'itinerary', req.params.id as string, {
      changes: Object.keys(req.body ?? {}),
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await itineraryService.deleteItinerary(req.params.id as string, req.user!.userId, req.user!.role);
    audit(req, 'itinerary.delete', 'itinerary', req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function addItemHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.addItem(req.params.id as string, req.user!.userId, req.user!.role, req.body);
    audit(req, 'itinerary.item.add', 'itinerary', req.params.id as string, {
      itemId: result.id,
      resourceId: result.resourceId,
      dayNumber: result.dayNumber,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateItemHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.updateItem(
      req.params.id as string,
      req.params.itemId as string,
      req.user!.userId,
      req.user!.role,
      req.body,
    );
    audit(req, 'itinerary.item.update', 'itinerary', req.params.id as string, {
      itemId: req.params.itemId,
      changes: Object.keys(req.body ?? {}),
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function removeItemHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await itineraryService.removeItem(req.params.id as string, req.params.itemId as string, req.user!.userId, req.user!.role);
    audit(req, 'itinerary.item.delete', 'itinerary', req.params.id as string, {
      itemId: req.params.itemId,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function listItemsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { dayNumber } = req.query;
    const result = await itineraryService.listItems(
      req.params.id as string,
      req.user!.userId,
      req.user!.role,
      dayNumber ? Number(dayNumber) : undefined,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getVersionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await itineraryService.getVersions(req.params.id as string, req.user!.userId, req.user!.role);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function optimizeItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { dayNumber } = req.query;
    const result = await routingService.optimizeItinerary(
      req.params.id as string,
      req.user!.userId,
      req.user!.role,
      dayNumber ? Number(dayNumber) : undefined,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function shareItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await enforceOwnership(req.params.id as string, req.user!.userId, req.user!.role);

    const prisma = getPrisma();
    const shareToken = crypto.randomBytes(32).toString('hex');
    const shareExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.itinerary.update({
      where: { id: req.params.id as string },
      data: { shareToken, shareExpiresAt },
    });

    audit(req, 'itinerary.share', 'itinerary', req.params.id as string, { expiresAt: shareExpiresAt });

    const shareUrl = `/shared/${shareToken}`;
    res.status(200).json({ shareToken, shareUrl, expiresAt: shareExpiresAt });
  } catch (err) {
    next(err);
  }
}

export async function getSharedItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const prisma = getPrisma();
    const itinerary = await prisma.itinerary.findFirst({
      where: { shareToken: req.params.token as string },
      include: {
        items: {
          include: { resource: true },
          orderBy: [{ dayNumber: 'asc' }, { startTime: 'asc' }],
        },
      },
    });

    if (!itinerary || !itinerary.shareExpiresAt || itinerary.shareExpiresAt < new Date()) {
      // Route through the global AppError handler so the response carries
      // the canonical envelope (statusCode/code/message/requestId) instead
      // of an ad-hoc { message } body. Audit issue 4.
      throw new AppError(404, NOT_FOUND, 'Shared itinerary not found or link has expired');
    }

    res.status(200).json(itinerary);
  } catch (err) {
    next(err);
  }
}

export async function exportItineraryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await enforceOwnership(req.params.id as string, req.user!.userId, req.user!.role);

    const prisma = getPrisma();
    const itinerary = await prisma.itinerary.findUnique({
      where: { id: req.params.id as string },
      include: {
        items: {
          include: { resource: true },
          orderBy: [{ dayNumber: 'asc' }, { startTime: 'asc' }],
        },
      },
    });

    if (!itinerary) {
      // Same canonical-envelope routing as the shared handler above.
      throw new AppError(404, NOT_FOUND, 'Itinerary not found');
    }

    res.status(200).json({
      schemaVersion: '1.0',
      itinerary: {
        id: itinerary.id,
        title: itinerary.title,
        destination: itinerary.destination,
        startDate: itinerary.startDate,
        endDate: itinerary.endDate,
        status: itinerary.status,
        createdAt: itinerary.createdAt,
        updatedAt: itinerary.updatedAt,
      },
      items: itinerary.items.map((item) => ({
        id: item.id,
        dayNumber: item.dayNumber,
        startTime: item.startTime,
        endTime: item.endTime,
        notes: item.notes,
        position: item.position,
        resource: item.resource,
      })),
    });
  } catch (err) {
    next(err);
  }
}
