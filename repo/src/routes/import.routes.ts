import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware, requirePermission } from '../middleware/auth.middleware';
import { uploadFieldsSchema, batchIdParamSchema } from '../schemas/import.schemas';
import { getTraceId } from '../utils/logger';
import { ZodError } from 'zod';
import {
  downloadTemplateHandler,
  uploadHandler,
  commitHandler,
  rollbackHandler,
  getBatchStatusHandler,
} from '../controllers/import.controller';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function validateUploadFields(req: Request, res: Response, next: NextFunction): void {
  try {
    uploadFieldsSchema.parse(req.body);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })), traceId: getTraceId() });
      return;
    }
    next(err);
  }
}

function validateBatchIdParam(req: Request, res: Response, next: NextFunction): void {
  try {
    batchIdParamSchema.parse(req.params);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })), traceId: getTraceId() });
      return;
    }
    next(err);
  }
}

router.get('/import/templates/:entityType', authMiddleware, downloadTemplateHandler);
router.post('/import/upload', authMiddleware, requirePermission('import:write'), upload.single('file'), validateUploadFields, uploadHandler);
router.post('/import/:batchId/commit', authMiddleware, requirePermission('import:write'), validateBatchIdParam, commitHandler);
router.post('/import/:batchId/rollback', authMiddleware, requirePermission('import:write'), validateBatchIdParam, rollbackHandler);
router.get('/import/:batchId', authMiddleware, getBatchStatusHandler);

export default router;
