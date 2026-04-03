import { Request, Response, NextFunction } from 'express';
import * as importService from '../services/import.service';

export async function downloadTemplateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entityType = req.params.entityType as string;
    const buffer = await importService.downloadTemplate(entityType);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entityType}-template.xlsx"`);
    res.status(200).send(buffer);
  } catch (err) {
    next(err);
  }
}

export async function uploadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = req.file as Express.Multer.File;
    const { entityType, idempotencyKey, deduplicationKey } = req.body;
    const result = await importService.uploadAndValidate(
      req.user!.userId,
      { buffer: file.buffer, originalname: file.originalname },
      entityType,
      idempotencyKey,
      deduplicationKey,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function commitHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const batchId = req.params.batchId as string;
    const result = await importService.commitBatch(batchId, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function rollbackHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const batchId = req.params.batchId as string;
    const result = await importService.rollbackBatch(batchId, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getBatchStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const batchId = req.params.batchId as string;
    const result = await importService.getBatchStatus(batchId, req.user!.userId, req.user!.role);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
