import { Router } from 'express';
import { authMiddleware, requirePermission } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createItinerarySchema, updateItinerarySchema, addItemSchema, updateItemSchema } from '../schemas/itinerary.schemas';
import {
  createItineraryHandler,
  listItinerariesHandler,
  getItineraryHandler,
  updateItineraryHandler,
  deleteItineraryHandler,
  addItemHandler,
  updateItemHandler,
  removeItemHandler,
  listItemsHandler,
  getVersionsHandler,
  optimizeItineraryHandler,
  shareItineraryHandler,
  getSharedItineraryHandler,
  exportItineraryHandler,
} from '../controllers/itineraries.controller';

const router = Router();

router.use(authMiddleware);

router.get('/', listItinerariesHandler);
router.post('/', requirePermission('itinerary:write'), validate(createItinerarySchema), createItineraryHandler);
router.get('/:id', getItineraryHandler);
router.patch('/:id', requirePermission('itinerary:write'), validate(updateItinerarySchema), updateItineraryHandler);
router.delete('/:id', requirePermission('itinerary:delete'), deleteItineraryHandler);

router.get('/:id/items', listItemsHandler);
router.post('/:id/items', requirePermission('itinerary:write'), validate(addItemSchema), addItemHandler);
router.patch('/:id/items/:itemId', requirePermission('itinerary:write'), validate(updateItemSchema), updateItemHandler);
router.delete('/:id/items/:itemId', requirePermission('itinerary:write'), removeItemHandler);

router.get('/:id/optimize', optimizeItineraryHandler);
router.get('/:id/versions', getVersionsHandler);
router.post('/:id/share', requirePermission('itinerary:write'), shareItineraryHandler);
router.get('/:id/export', exportItineraryHandler);

const sharedRouter = Router();
sharedRouter.get('/shared/:token', getSharedItineraryHandler);

export default router;
export { sharedRouter };
