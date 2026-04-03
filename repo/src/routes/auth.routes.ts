import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { registerSchema, loginSchema, changePasswordSchema, recoverSchema, refreshSchema } from '../schemas/auth.schemas';
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  changePasswordHandler,
  recoverHandler,
  getMeHandler,
  getDevicesHandler,
  removeDeviceHandler,
} from '../controllers/auth.controller';

const router = Router();

// Public endpoints
router.post('/register', validate(registerSchema), registerHandler);
router.post('/login', validate(loginSchema), loginHandler);
router.post('/refresh', validate(refreshSchema), refreshHandler);
router.post('/recover', validate(recoverSchema), recoverHandler);

// Protected endpoints
router.post('/logout', authMiddleware, logoutHandler);
router.patch('/change-password', authMiddleware, validate(changePasswordSchema), changePasswordHandler);
router.get('/me', authMiddleware, getMeHandler);
router.get('/devices', authMiddleware, getDevicesHandler);
router.delete('/devices/:id', authMiddleware, removeDeviceHandler);

export default router;
