import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/auth.service';
import { logAction } from '../services/audit.service';
import { getTraceId } from '../utils/logger';

export async function registerHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, password, securityQuestions } = req.body;
    const result = await authService.register(username, password, securityQuestions);
    logAction(result.id, 'user.register', 'user', result.id, { username }, getTraceId()).catch(() => {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function loginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, password, deviceFingerprint, lastKnownCity, challengeToken } = req.body;
    const result = await authService.login(username, password, deviceFingerprint, lastKnownCity, challengeToken);

    // Challenge response (unusual location)
    if ('challengeToken' in result) {
      res.status(429).json(result);
      return;
    }

    logAction(result.user.id, 'user.login', 'user', result.user.id, { username }, getTraceId()).catch(() => {});
    res.status(200).json({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      user: result.user,
    });
  } catch (err) {
    next(err);
  }
}

export async function refreshHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body;
    const result = await authService.refresh(refreshToken);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body;
    await authService.logout(refreshToken);
    logAction(req.user!.userId, 'user.logout', 'user', req.user!.userId, {}, getTraceId()).catch(() => {});
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function changePasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(req.user!.userId, currentPassword, newPassword);
    logAction(req.user!.userId, 'user.change_password', 'user', req.user!.userId, {}, getTraceId()).catch(() => {});
    res.status(200).json({ message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
}

export async function recoverHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, answers, newPassword } = req.body;
    await authService.recoverPassword(username, answers, newPassword);
    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
}

export async function getMeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await authService.getMe(req.user!.userId);
    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
}

export async function getDevicesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const devices = await authService.getDevices(req.user!.userId);
    res.status(200).json(devices);
  } catch (err) {
    next(err);
  }
}

export async function removeDeviceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await authService.removeDevice(req.user!.userId, req.params.id as string);
    logAction(req.user!.userId, 'device.remove', 'device', req.params.id as string, {}, getTraceId()).catch(() => {});
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
