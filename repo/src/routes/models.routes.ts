import { Router } from 'express';
import { authMiddleware, requireRole, requirePermission } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { registerModelSchema, updateModelStatusSchema, abAllocationSchema, inferSchema } from '../schemas/model.schemas';
import {
  registerModelHandler,
  listModelsHandler,
  getModelHandler,
  updateModelStatusHandler,
  setAbAllocationHandler,
  inferHandler,
} from '../controllers/models.controller';

const router = Router();

router.use(authMiddleware);

router.get('/', listModelsHandler);
router.post('/', requirePermission('model:write'), validate(registerModelSchema), registerModelHandler);
router.get('/:id', getModelHandler);
router.patch('/:id', requirePermission('model:write'), validate(updateModelStatusSchema), updateModelStatusHandler);
router.post('/:id/ab-allocations', requireRole('admin'), validate(abAllocationSchema), setAbAllocationHandler);
router.post('/:id/infer', requirePermission('model:read'), validate(inferSchema), inferHandler);

export default router;
