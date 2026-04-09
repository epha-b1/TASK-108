import { Request, Response, NextFunction } from 'express';
import * as notificationService from '../services/notification.service';
import { audit } from '../services/audit.service';
import { notificationLog } from '../utils/logger';

export async function createTemplateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code, subject, body } = req.body;
    const result = await notificationService.createTemplate(code, subject, body);
    audit(req, 'notification.template.create', 'notification_template', result.id, { code });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listTemplatesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await notificationService.listTemplates();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateTemplateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await notificationService.updateTemplate(req.params.id as string, req.body);
    audit(req, 'notification.template.update', 'notification_template', req.params.id as string, {
      changes: Object.keys(req.body ?? {}),
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function sendNotificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, type, templateCode, variables, subject, message } = req.body;
    const result = await notificationService.sendNotification(userId, type, templateCode, variables, subject, message);
    audit(req, 'notification.send', 'notification', result.id, {
      recipientUserId: userId,
      type,
      templateCode: templateCode ?? null,
    });
    // Hygiene: do not log message body or template variables (may contain PII).
    notificationLog.info('notification.send', {
      notificationId: result.id,
      recipientUserId: userId,
      type,
      templateCode: templateCode ?? null,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listNotificationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { read, page, limit } = req.query;
    const readFilter = read !== undefined ? read === 'true' : undefined;
    const result = await notificationService.listNotifications(
      req.user!.userId,
      readFilter,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function markReadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await notificationService.markRead(req.params.id as string, req.user!.userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getStatsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await notificationService.getStats();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
