import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware, requirePermission } from '../middleware/auth.middleware';
import { uploadFieldsSchema, batchIdParamSchema } from '../schemas/import.schemas';
import { getRequestId } from '../utils/logger';
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

function validationErrorBody(err: ZodError) {
  const requestId = getRequestId();
  return {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    requestId,
    traceId: requestId,
  };
}

function validateUploadFields(req: Request, res: Response, next: NextFunction): void {
  try {
    uploadFieldsSchema.parse(req.body);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json(validationErrorBody(err));
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
      res.status(400).json(validationErrorBody(err));
      return;
    }
    next(err);
  }
}

// Templates contain no sensitive data — they are reference schemas for the
// upload format. Both docs/api-spec.md and src/config/swagger.ts mark this
// endpoint as public; the route now matches.
router.get('/import/templates/:entityType', downloadTemplateHandler);
router.post('/import/upload', authMiddleware, requirePermission('import:write'), upload.single('file'), validateUploadFields, uploadHandler);
router.post('/import/:batchId/commit', authMiddleware, requirePermission('import:write'), validateBatchIdParam, commitHandler);
router.post('/import/:batchId/rollback', authMiddleware, requirePermission('import:write'), validateBatchIdParam, rollbackHandler);
// Read endpoints are now protected by `import:read` so a token without the
// permission point cannot poll batch status. Object-level isolation is still
// enforced inside the service.
router.get('/import/:batchId', authMiddleware, requirePermission('import:read'), getBatchStatusHandler);

export default router;
