import { Router } from 'express';
import { authMiddleware, requireRole } from '../middleware/auth.middleware';
import {
  queryAuditLogsHandler,
  exportAuditLogsCsvHandler,
} from '../controllers/audit.controller';

const router = Router();

router.get('/audit-logs', authMiddleware, requireRole('admin'), queryAuditLogsHandler);
router.get('/audit-logs/export', authMiddleware, requireRole('admin'), exportAuditLogsCsvHandler);

export default router;
