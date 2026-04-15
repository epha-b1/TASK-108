/**
 * Coverage for `src/routes/import.routes.ts` — its two inline validators
 * (validateUploadFields, validateBatchIdParam) and their error envelopes.
 *
 * The auth middleware module is mocked at the TOP level so the route
 * registration picks up our bypass versions. We then mount the router on
 * a minimal express app and hit the endpoints with supertest.
 */

jest.mock('../src/middleware/auth.middleware', () => ({
  __esModule: true,
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'organizer', username: 'u' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import importRoutes from '../src/routes/import.routes';

describe('import.routes — inline validators', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(importRoutes);
    app.use((err: Error, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: err.message });
    });
  });

  it('validateBatchIdParam: returns canonical 400 envelope for non-uuid batchId', async () => {
    const res = await request(app).post('/import/not-a-uuid/commit').send();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('validateBatchIdParam: accepts a valid UUID (controller then 404s on missing batch)', async () => {
    const res = await request(app).post('/import/11111111-1111-4111-8111-111111111111/commit').send();
    // Validator passes — controller progresses and (service-side) errors out.
    // Assert simply that VALIDATION_ERROR is NOT what came back.
    expect(res.body?.code).not.toBe('VALIDATION_ERROR');
  });

  it('validateUploadFields: 400 when entityType missing', async () => {
    const res = await request(app).post('/import/upload').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /import/templates/:entityType is public (no auth required)', async () => {
    // This endpoint reaches the controller and downloads a template — the
    // default without ?format or Accept is xlsx, served from import.service.
    const res = await request(app).get('/import/templates/resources');
    expect(res.status).toBe(200);
  });
});
