import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/auth.service';
import { audit, logAction } from '../services/audit.service';
import { getRequestId, authLog } from '../utils/logger';
import { CHALLENGE_REQUIRED } from '../utils/errors';

export async function registerHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, password, securityQuestions } = req.body;
    const result = await authService.register(username, password, securityQuestions);
    // Self-registration: actor IS the new user, so we use logAction directly.
    logAction(result.id, 'user.register', 'user', result.id, { username }, getRequestId()).catch(() => {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function loginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, password, deviceFingerprint, lastKnownCity, challengeToken } = req.body;
    const result = await authService.login(username, password, deviceFingerprint, lastKnownCity, challengeToken);

    // Unusual-location challenge ISSUANCE branch.
    //
    // Wrapped in the canonical error envelope (statusCode/code/message/
    // requestId/traceId) so envelope.api.spec.ts and the new
    // assert429Envelope helper see a consistent shape regardless of which
    // 429 path produced the response. The challengeToken / retryAfterSeconds
    // fields from the service are preserved at the top level so existing
    // clients keep working unchanged.
    if ('challengeToken' in result) {
      const requestId = getRequestId();
      authLog.warn('login.challenge_issued', {
        username,
        // Don't log the token itself — it's a one-shot bearer.
        retryAfterSeconds: result.retryAfterSeconds,
      });
      res.status(429).json({
        statusCode: 429,
        code: CHALLENGE_REQUIRED,
        message: result.message,
        requestId,
        traceId: requestId,
        challengeToken: result.challengeToken,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    logAction(result.user.id, 'user.login', 'user', result.user.id, { username }, getRequestId()).catch(() => {});
    authLog.info('login.success', { userId: result.user.id, username });
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
    audit(req, 'user.logout', 'user', req.user!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function changePasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(req.user!.userId, currentPassword, newPassword);
    audit(req, 'user.change_password', 'user', req.user!.userId);
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
    audit(req, 'device.remove', 'device', req.params.id as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
