import { Request, Response, NextFunction } from 'express';
import * as auditService from '../services/audit.service';

export async function queryAuditLogsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { actorId, action, resourceType, from, to, page, limit } = req.query;
    const result = await auditService.queryAuditLogs({
      actorId: actorId as string | undefined,
      action: action as string | undefined,
      resourceType: resourceType as string | undefined,
      from: from as string | undefined,
      to: to as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function exportAuditLogsCsvHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { actorId, action, resourceType, from, to } = req.query;
    const csv = await auditService.exportAuditLogsCsv({
      actorId: actorId as string | undefined,
      action: action as string | undefined,
      resourceType: resourceType as string | undefined,
      from: from as string | undefined,
      to: to as string | undefined,
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}
