import { Request, Response, NextFunction } from 'express';
import * as importService from '../services/import.service';
import { audit } from '../services/audit.service';
import { importLog } from '../utils/logger';

export async function downloadTemplateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entityType = req.params.entityType as string;

    // Format selection: explicit `?format=csv|xlsx` query param wins; otherwise
    // we honour the Accept header so a `text/csv` request gets a CSV without
    // having to know the query-param contract. Defaults to xlsx for backwards
    // compatibility with the historical XLSX-only behaviour.
    const queryFormat = String(req.query.format ?? '').toLowerCase();
    let format: 'csv' | 'xlsx';
    if (queryFormat === 'csv' || queryFormat === 'xlsx') {
      format = queryFormat;
    } else if (queryFormat) {
      res.status(400).json({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'format must be one of: csv, xlsx',
      });
      return;
    } else {
      const accept = String(req.headers.accept ?? '').toLowerCase();
      if (accept.includes('text/csv')) {
        format = 'csv';
      } else {
        format = 'xlsx';
      }
    }

    const bundle = await importService.downloadTemplate(entityType, format);
    res.setHeader('Content-Type', bundle.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);
    res.status(200).send(bundle.body);
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
    if (result?.id) {
      audit(req, 'import.upload', 'import_batch', result.id, {
        entityType,
        totalRows: result.totalRows,
        successRows: result.successRows,
        errorRows: result.errorRows,
      });
      importLog.info('import.upload', {
        batchId: result.id,
        entityType,
        totalRows: result.totalRows,
        successRows: result.successRows,
        errorRows: result.errorRows,
      });
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function commitHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const batchId = req.params.batchId as string;
    const result = await importService.commitBatch(batchId, req.user!.userId);
    audit(req, 'import.commit', 'import_batch', batchId, {
      entityType: result.entityType,
      successRows: result.successRows,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function rollbackHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const batchId = req.params.batchId as string;
    const result = await importService.rollbackBatch(batchId, req.user!.userId);
    audit(req, 'import.rollback', 'import_batch', batchId, {
      entityType: result.entityType,
    });
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
