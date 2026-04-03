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

router.get('/notifications', authMiddleware, listNotificationsHandler);
router.patch('/notifications/:id/read', authMiddleware, markReadHandler);
router.get('/notifications/stats', authMiddleware, requireRole('admin'), getStatsHandler);

router.post('/notifications', authMiddleware, requirePermission('notification:write'), validate(sendNotificationSchema), sendNotificationHandler);

router.get('/notification-templates', authMiddleware, listTemplatesHandler);
router.post('/notification-templates', authMiddleware, requireRole('admin'), validate(createTemplateSchema), createTemplateHandler);
router.patch('/notification-templates/:id', authMiddleware, requireRole('admin'), validate(updateTemplateSchema), updateTemplateHandler);

export default router;
