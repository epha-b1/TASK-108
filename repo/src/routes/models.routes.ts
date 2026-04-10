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

// Permission matrix:
//   read  → model:read
//   write → model:write
//   ab-allocations → admin role only (controls live traffic split, kept tighter)
//   infer → model:read (treated as a read-side decisioning call)
router.get('/', requirePermission('model:read'), listModelsHandler);
router.post('/', requirePermission('model:write'), validate(registerModelSchema), registerModelHandler);
router.get('/:id', requirePermission('model:read'), getModelHandler);
router.patch('/:id', requirePermission('model:write'), validate(updateModelStatusSchema), updateModelStatusHandler);
router.post('/:id/ab-allocations', requireRole('admin'), validate(abAllocationSchema), setAbAllocationHandler);
router.post('/:id/infer', requirePermission('model:read'), validate(inferSchema), inferHandler);

export default router;
