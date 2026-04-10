/**
 * Security regression tests.
 *
 * The previous version of this file replicated `safeEvaluateCondition`
 * locally and tested the copy, which gave green CI even when the real
 * production parser drifted away from the spec. This rewrite imports
 * the REAL functions from `src/services/model.service.ts` and
 * `src/utils/errors.ts` so the assertions track production behaviour
 * directly. Audit issue 6.
 *
 * Coverage:
 *   - safeEvaluateCondition: numeric / string / boolean / negative-number
 *     happy paths, plus injection / loose-equality / prototype-pollution
 *     rejection paths.
 *   - AppError envelope shape (statusCode / code / message / details).
 *   - getAdapter() in mock mode returns a working adapter that produces
 *     a well-formed inference result, exercised through the real export.
 */

import {
  safeEvaluateCondition,
  getAdapter,
} from '../src/services/model.service';
import { AppError } from '../src/utils/errors';

describe('safeEvaluateCondition (real production export)', () => {
  it('numeric > comparison', () => {
    expect(safeEvaluateCondition('input.budget > 100', { budget: 200 })).toBe(true);
    expect(safeEvaluateCondition('input.budget > 100', { budget: 50 })).toBe(false);
  });

  it('numeric >= boundary', () => {
    expect(safeEvaluateCondition('input.x >= 5', { x: 5 })).toBe(true);
    expect(safeEvaluateCondition('input.x >= 5', { x: 4.999 })).toBe(false);
  });

  it('string === comparison', () => {
    expect(safeEvaluateCondition('input.category === "luxury"', { category: 'luxury' })).toBe(true);
    expect(safeEvaluateCondition('input.category === "luxury"', { category: 'budget' })).toBe(false);
  });

  it('boolean === comparison', () => {
    expect(safeEvaluateCondition('input.premium === true', { premium: true })).toBe(true);
    expect(safeEvaluateCondition('input.premium === false', { premium: true })).toBe(false);
  });

  it('negative-number numeric comparison', () => {
    expect(safeEvaluateCondition('input.temp < -10', { temp: -20 })).toBe(true);
    expect(safeEvaluateCondition('input.temp < -10', { temp: -5 })).toBe(false);
  });

  it('rejects code injection / RCE attempts', () => {
    expect(safeEvaluateCondition('process.exit(1)', {})).toBe(false);
    expect(safeEvaluateCondition('require("fs").unlinkSync("/")', {})).toBe(false);
    expect(safeEvaluateCondition('input.x; process.exit(1)', { x: 1 })).toBe(false);
    expect(safeEvaluateCondition('(function(){return true})()', {})).toBe(false);
  });

  it('rejects prototype pollution attempts', () => {
    expect(safeEvaluateCondition('input.__proto__.polluted > 0', {})).toBe(false);
    expect(safeEvaluateCondition('input.constructor === Object', {})).toBe(false);
  });

  it('rejects loose equality (== / !=) — only strict supported', () => {
    expect(safeEvaluateCondition('input.x == 5', { x: 5 })).toBe(false);
    expect(safeEvaluateCondition('input.x != 5', { x: 3 })).toBe(false);
  });

  it('handles missing field cleanly (does not throw)', () => {
    expect(() => safeEvaluateCondition('input.missing > 5', {})).not.toThrow();
    expect(safeEvaluateCondition('input.missing > 5', {})).toBe(false);
  });
});

describe('AppError envelope contract', () => {
  it('preserves statusCode, code, message and structured details', () => {
    const devices = [
      { id: 'd1', lastSeenAt: new Date() },
      { id: 'd2', lastSeenAt: new Date() },
    ];
    const err = new AppError(409, 'DEVICE_LIMIT_REACHED', 'Max 5 devices', { devices });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('DEVICE_LIMIT_REACHED');
    expect(err.message).toBe('Max 5 devices');
    expect((err.details as { devices: unknown[] }).devices).toHaveLength(2);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('Model adapter selection (real getAdapter export, mock mode)', () => {
  it('mock mode returns an adapter regardless of model type', () => {
    // NODE_ENV=test in jest, so MODEL_ADAPTER_MODE defaults to 'mock' and
    // every call returns the deterministic MockAdapter.
    for (const t of ['pmml', 'onnx', 'custom', 'unknown-type']) {
      const adapter = getAdapter(t);
      expect(adapter).toBeDefined();
      expect(typeof adapter.infer).toBe('function');
    }
  });

  it('mock adapter produces a well-formed inference result', async () => {
    const adapter = getAdapter('custom');
    const result = await adapter.infer({ budget: 100, nights: 3 }, null);
    expect(result.prediction).toBeDefined();
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.topFeatures)).toBe(true);
  });

  it('mock adapter is deterministic for the same input', async () => {
    const adapter = getAdapter('custom');
    const a = await adapter.infer({ budget: 100, nights: 3 }, null);
    const b = await adapter.infer({ budget: 100, nights: 3 }, null);
    expect(a.prediction).toEqual(b.prediction);
    expect(a.confidence).toBe(b.confidence);
  });
});
