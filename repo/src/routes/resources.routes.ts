import { Router } from 'express';
import { authMiddleware, requirePermission } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createResourceSchema, updateResourceSchema, businessHoursSchema, closureSchema, travelTimeSchema } from '../schemas/resource.schemas';
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

// Permission matrix:
//   read  → resource:read
//   write → resource:write
//   delete → resource:delete
// Applied uniformly to read AND mutate so a partial role still cannot
// enumerate the resource catalogue.
router.get('/', requirePermission('resource:read'), listResourcesHandler);
router.post('/', requirePermission('resource:write'), validate(createResourceSchema), createResourceHandler);
router.get('/:id', requirePermission('resource:read'), getResourceHandler);
router.patch('/:id', requirePermission('resource:write'), validate(updateResourceSchema), updateResourceHandler);
router.delete('/:id', requirePermission('resource:delete'), deleteResourceHandler);

router.get('/:id/hours', requirePermission('resource:read'), getBusinessHoursHandler);
router.post('/:id/hours', requirePermission('resource:write'), validate(businessHoursSchema), setBusinessHoursHandler);

router.get('/:id/closures', requirePermission('resource:read'), getClosuresHandler);
router.post('/:id/closures', requirePermission('resource:write'), validate(closureSchema), addClosureHandler);

export default router;

const travelTimesRouter = Router();
travelTimesRouter.use(authMiddleware);
travelTimesRouter.get('/', requirePermission('resource:read'), listTravelTimesHandler);
travelTimesRouter.post('/', requirePermission('resource:write'), validate(travelTimeSchema), upsertTravelTimeHandler);

export { travelTimesRouter };
