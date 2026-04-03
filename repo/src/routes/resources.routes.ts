import { Router } from 'express';
import { authMiddleware, requirePermission } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createResourceSchema, businessHoursSchema, closureSchema, travelTimeSchema } from '../schemas/resource.schemas';
import {
  createResourceHandler,
  listResourcesHandler,
  getResourceHandler,
  updateResourceHandler,
  deleteResourceHandler,
  setBusinessHoursHandler,
  getBusinessHoursHandler,
  addClosureHandler,
  getClosuresHandler,
  upsertTravelTimeHandler,
  listTravelTimesHandler,
} from '../controllers/resources.controller';

const router = Router();

router.use(authMiddleware);

router.get('/', listResourcesHandler);
router.post('/', requirePermission('resource:write'), validate(createResourceSchema), createResourceHandler);
router.get('/:id', getResourceHandler);
router.patch('/:id', requirePermission('resource:write'), updateResourceHandler);
router.delete('/:id', requirePermission('resource:delete'), deleteResourceHandler);

router.get('/:id/hours', getBusinessHoursHandler);
router.post('/:id/hours', requirePermission('resource:write'), validate(businessHoursSchema), setBusinessHoursHandler);

router.get('/:id/closures', getClosuresHandler);
router.post('/:id/closures', requirePermission('resource:write'), validate(closureSchema), addClosureHandler);

export default router;

const travelTimesRouter = Router();
travelTimesRouter.use(authMiddleware);
travelTimesRouter.get('/', listTravelTimesHandler);
travelTimesRouter.post('/', requirePermission('resource:write'), validate(travelTimeSchema), upsertTravelTimeHandler);

export { travelTimesRouter };
