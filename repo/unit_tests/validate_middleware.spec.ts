/**
 * Coverage for `src/middleware/validate.middleware.ts`.
 *
 * Drives: (a) happy path where the schema mutates req.body and next()
 * is called, (b) ZodError path where a 400 envelope is written with
 * canonical fields, (c) non-Zod error path where the error is rethrown
 * through next(err).
 */

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { validate } from '../src/middleware/validate.middleware';

function rr(body: unknown) {
  const jsonCalls: unknown[] = [];
  const state = { statusCode: 200 };
  const req = { body } as unknown as Request;
  const res = {
    status(c: number) { state.statusCode = c; return this; },
    json(b: unknown) { jsonCalls.push(b); return this; },
  } as unknown as Response;
  const nextCalls: unknown[] = [];
  const next: NextFunction = (err?: unknown) => { nextCalls.push(err ?? null); };
  return { req, res, next, jsonCalls, state, nextCalls };
}

describe('validate middleware', () => {
  const schema = z.object({ name: z.string().min(1), count: z.number().int().positive() });

  it('accepts valid body and passes to next()', () => {
    const { req, res, next, nextCalls } = rr({ name: 'x', count: 2 });
    validate(schema)(req, res, next);
    expect(nextCalls).toEqual([null]);
    expect(req.body).toEqual({ name: 'x', count: 2 });
  });

  it('returns canonical 400 envelope on Zod failure with per-field details', () => {
    const { req, res, next, jsonCalls, state, nextCalls } = rr({ name: '', count: -1 });
    validate(schema)(req, res, next);
    expect(nextCalls).toHaveLength(0); // did not fall through
    expect(state.statusCode).toBe(400);
    const body = jsonCalls[0] as any;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: expect.any(String), message: expect.any(String) }),
    ]));
    expect(body).toHaveProperty('requestId');
    expect(body).toHaveProperty('traceId');
  });

  it('propagates non-Zod errors via next(err)', () => {
    const throwingSchema = { parse: () => { throw new Error('boom'); } } as any;
    const { req, res, next, nextCalls } = rr({});
    validate(throwingSchema)(req, res, next);
    expect(nextCalls).toHaveLength(1);
    expect(nextCalls[0]).toBeInstanceOf(Error);
  });
});
