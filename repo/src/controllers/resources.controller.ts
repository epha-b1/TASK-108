import { Request, Response, NextFunction } from 'express';
import * as resourceService from '../services/resource.service';

export async function createResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.createResource(req.body);
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
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteResourceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await resourceService.deleteResource(req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function setBusinessHoursHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await resourceService.setBusinessHours(req.params.id as string, req.body);
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
