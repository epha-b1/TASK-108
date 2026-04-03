import { Request, Response, NextFunction } from 'express';
import * as modelService from '../services/model.service';

export async function registerModelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await modelService.registerModel(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listModelsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await modelService.listModels();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getModelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await modelService.getModel(req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateModelStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await modelService.updateModelStatus(req.params.id as string, req.body.status);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function setAbAllocationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { groupName, percentage } = req.body;
    const result = await modelService.setAbAllocation(req.params.id as string, groupName, percentage);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function inferHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { input, context } = req.body;
    const result = await modelService.infer(req.params.id as string, input, context, req.user?.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
