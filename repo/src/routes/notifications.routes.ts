import { Router } from 'express';
import { authMiddleware, requireRole, requirePermission } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { sendNotificationSchema, createTemplateSchema, updateTemplateSchema } from '../schemas/notification.schemas';
import {
  createTemplateHandler,
  listTemplatesHandler,
  updateTemplateHandler,
  sendNotificationHandler,
  listNotificationsHandler,
  markReadHandler,
  getStatsHandler,
} from '../controllers/notifications.controller';

const router = Router();

// Permission matrix:
//   notification:read   → list own notifications, list templates, mark read
//   notification:write  → send notification
//   admin role          → stats, template create/update
// `notification:read` is enforced consistently on read endpoints so an account
// without the permission point cannot use the API to enumerate notification
// state, even if its JWT is valid.
router.get('/notifications', authMiddleware, requirePermission('notification:read'), listNotificationsHandler);
router.patch('/notifications/:id/read', authMiddleware, requirePermission('notification:read'), markReadHandler);
router.get('/notifications/stats', authMiddleware, requireRole('admin'), getStatsHandler);

router.post('/notifications', authMiddleware, requirePermission('notification:write'), validate(sendNotificationSchema), sendNotificationHandler);

router.get('/notification-templates', authMiddleware, requirePermission('notification:read'), listTemplatesHandler);
router.post('/notification-templates', authMiddleware, requireRole('admin'), validate(createTemplateSchema), createTemplateHandler);
router.patch('/notification-templates/:id', authMiddleware, requireRole('admin'), validate(updateTemplateSchema), updateTemplateHandler);

export default router;
