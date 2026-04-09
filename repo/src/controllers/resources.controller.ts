import { Request, Response, NextFunction } from 'express';
import * as resourceService from '../services/resource.service';
import { audit } from '../services/audit.service';
import { resourceLog } from '../utils/logger';

export async function createResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.createResource(req.body);
    audit(req, 'resource.create', 'resource', result.id, { name: result.name, type: result.type });
    resourceLog.info('resource.create', { resourceId: result.id, type: result.type });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listResourcesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { type, city, page, limit } = req.query;
    const result = await resourceService.listResources({
      type: type as string | undefined,
      city: city as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.getResource(req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.updateResource(req.params.id as string, req.body);
    audit(req, 'resource.update', 'resource', req.params.id as string, { changes: Object.keys(req.body ?? {}) });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await resourceService.deleteResource(req.params.id as string);
    audit(req, 'resource.delete', 'resource', req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function setBusinessHoursHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.setBusinessHours(req.params.id as string, req.body);
    audit(req, 'resource.hours.set', 'resource', req.params.id as string, {
      dayOfWeek: result.dayOfWeek,
      openTime: result.openTime,
      closeTime: result.closeTime,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getBusinessHoursHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.getBusinessHours(req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function addClosureHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.addClosure(req.params.id as string, req.body);
    audit(req, 'resource.closure.add', 'resource', req.params.id as string, {
      date: result.date,
      reason: result.reason,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getClosuresHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.getClosures(req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function upsertTravelTimeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.upsertTravelTime(req.body);
    audit(req, 'resource.travel_time.upsert', 'travel_time', result.id, {
      fromResourceId: result.fromResourceId,
      toResourceId: result.toResourceId,
      transportMode: result.transportMode,
      travelMinutes: result.travelMinutes,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listTravelTimesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { fromResourceId } = req.query;
    const result = await resourceService.listTravelTimes(fromResourceId as string | undefined);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
