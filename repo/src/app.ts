import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import { auditMiddleware } from './middleware/audit.middleware';
import { idempotencyMiddleware } from './middleware/idempotency.middleware';
import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import { rolesRouter, permissionPointsRouter, menusRouter, userRolesRouter } from './routes/rbac.routes';
import resourcesRoutes, { travelTimesRouter } from './routes/resources.routes';
import itinerariesRoutes, { sharedRouter } from './routes/itineraries.routes';
import importRoutes from './routes/import.routes';
import modelsRoutes from './routes/models.routes';
import notificationsRoutes from './routes/notifications.routes';
import auditRoutes from './routes/audit.routes';
import { AppError, NOT_FOUND, INTERNAL_ERROR } from './utils/errors';
import { systemLog, getRequestId } from './utils/logger';
import { apiSpec } from './config/swagger';

const app = express();

app.use(helmet());
app.use(compression());
app.use(express.json());

app.use(auditMiddleware);
app.use(idempotencyMiddleware);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test-only safe trigger for the 500 error envelope path. Disabled outside
// NODE_ENV=test so it can never be reached in production.
if (process.env.NODE_ENV === 'test') {
  app.get('/__test__/boom', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('synthetic test failure for envelope assertions'));
  });
}

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(apiSpec));

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/roles', rolesRouter);
app.use('/permission-points', permissionPointsRouter);
app.use('/menus', menusRouter);
app.use('/users', userRolesRouter);
app.use('/resources', resourcesRoutes);
app.use('/travel-times', travelTimesRouter);
app.use('/itineraries', itinerariesRoutes);
app.use('/', sharedRouter);
app.use('/', importRoutes);
app.use('/models', modelsRoutes);
app.use('/', notificationsRoutes);
app.use('/', auditRoutes);

app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(404, NOT_FOUND, 'Resource not found'));
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = getRequestId();

  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      // Canonical field — every error response carries `requestId`. The legacy
      // `traceId` alias is kept temporarily so older clients don't break.
      requestId,
      traceId: requestId,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Unhandled errors go through the `system` category so observability tools
  // can alert on them independently of normal `request` logs.
  systemLog.error('unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    statusCode: 500,
    code: INTERNAL_ERROR,
    message: 'Internal server error',
    requestId,
    traceId: requestId,
  });
});

export default app;
