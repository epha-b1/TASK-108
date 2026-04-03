import { Request, Response, NextFunction } from 'express';
import * as notificationService from '../services/notification.service';

export async function createTemplateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code, subject, body } = req.body;
    const result = await notificationService.createTemplate(code, subject, body);
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
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function sendNotificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, type, templateCode, variables, subject, message } = req.body;
    const result = await notificationService.sendNotification(userId, type, templateCode, variables, subject, message);
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
