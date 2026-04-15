/**
 * Coverage for the remaining branches in `src/app.ts`:
 *   - 404 catch-all when no route matches
 *   - AppError path including `details` field propagation
 *   - Generic Error path → 500 envelope
 *   - GET /health endpoint
 *
 * Uses supertest against the real Express app (which jest.config.js
 * points at the mocked Prisma for unit tests).
 */

import request from 'supertest';
import app from '../src/app';

describe('app — error handling and health', () => {
  it('GET /health returns ok + timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('404 for unknown route carries canonical envelope', async () => {
    const res = await request(app).get('/no-such-endpoint');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: expect.any(String),
    });
    expect(res.body).toHaveProperty('requestId');
    expect(res.body).toHaveProperty('traceId');
  });

  it('500 for unhandled error routed through /__test__/boom', async () => {
    const res = await request(app).get('/__test__/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(res.body).toHaveProperty('requestId');
  });

  it('AppError `details` surface through to the response body', async () => {
    // /auth/register validates via zod; sending nothing triggers the
    // validate middleware which builds a 400 with a `details` array.
    // The idempotency middleware fires first on POST, so we must send a key.
    const res = await request(app)
      .post('/auth/register')
      .set('Idempotency-Key', 'test-key-register-empty')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});
