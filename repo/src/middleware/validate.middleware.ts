import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { getTraceId } from '../utils/logger';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
          traceId: getTraceId(),
        });
        return;
      }
      next(err);
    }
  };
}
