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

// Permission matrix (kept in sync with docs/api-spec.md and prisma/seed.ts):
//   read endpoints  → itinerary:read
//   write endpoints → itinerary:write
//   delete endpoints → itinerary:delete
// `requirePermission` is applied uniformly to BOTH read and mutate routes so
// that revoking a permission point on a role takes effect at the API edge.
// Admin role bypasses these checks via auth.middleware.ts.
router.get('/', requirePermission('itinerary:read'), listItinerariesHandler);
router.post('/', requirePermission('itinerary:write'), validate(createItinerarySchema), createItineraryHandler);
router.get('/:id', requirePermission('itinerary:read'), getItineraryHandler);
router.patch('/:id', requirePermission('itinerary:write'), validate(updateItinerarySchema), updateItineraryHandler);
router.delete('/:id', requirePermission('itinerary:delete'), deleteItineraryHandler);

router.get('/:id/items', requirePermission('itinerary:read'), listItemsHandler);
router.post('/:id/items', requirePermission('itinerary:write'), validate(addItemSchema), addItemHandler);
router.patch('/:id/items/:itemId', requirePermission('itinerary:write'), validate(updateItemSchema), updateItemHandler);
router.delete('/:id/items/:itemId', requirePermission('itinerary:write'), removeItemHandler);

router.get('/:id/optimize', requirePermission('itinerary:read'), optimizeItineraryHandler);
router.get('/:id/versions', requirePermission('itinerary:read'), getVersionsHandler);
router.post('/:id/share', requirePermission('itinerary:write'), shareItineraryHandler);
router.get('/:id/export', requirePermission('itinerary:read'), exportItineraryHandler);

const sharedRouter = Router();
sharedRouter.get('/shared/:token', getSharedItineraryHandler);

export default router;
export { sharedRouter };
