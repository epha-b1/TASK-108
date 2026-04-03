import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { traceStore } from '../utils/logger';
import { logger } from '../utils/logger';

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] as string) || (req.headers['x-request-id'] as string) || uuidv4();

  res.setHeader('X-Trace-Id', traceId);
  res.setHeader('X-Request-Id', traceId);

  traceStore.run({ traceId }, () => {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.info('request completed', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        duration,
        traceId,
      });
    });

    next();
  });
}
