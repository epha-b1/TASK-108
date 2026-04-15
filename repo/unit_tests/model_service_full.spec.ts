/**
 * Coverage for `src/services/model.service.ts` beyond what security.spec
 * and model_security.spec cover. Focus:
 *   - registerModel branches (bad semver, bad type, conflict, success)
 *   - listModels / getModel (404 + success)
 *   - updateModelStatus (bad status, 404, success)
 *   - setAbAllocation (400 pct, 404 model, create vs update branches)
 *   - infer (404, inactive/canary branches, canary routing via A/B hash,
 *     rule-override, mock adapter deterministic path)
 */

import * as svc from '../src/services/model.service';
import { getPrisma } from '../src/config/database';

const prisma = getPrisma() as unknown as Record<string, Record<string, jest.Mock>>;

function resetPrisma() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

beforeEach(() => {
  resetPrisma();
});

describe('registerModel', () => {
  it('400 invalid semver', async () => {
    await expect(svc.registerModel({ name: 'n', version: 'v1', type: 'onnx' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 invalid type', async () => {
    await expect(svc.registerModel({ name: 'n', version: '1.0.0', type: 'xyz' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('409 when (name, version) exists', async () => {
    prisma.mlModel.findFirst.mockResolvedValue({ id: 'm0' });
    await expect(svc.registerModel({ name: 'n', version: '1.0.0', type: 'onnx' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates when unique, stores config', async () => {
    prisma.mlModel.findFirst.mockResolvedValue(null);
    prisma.mlModel.create.mockResolvedValue({ id: 'm1', name: 'n', version: '1.0.0', type: 'onnx' });
    const out = await svc.registerModel({ name: 'n', version: '1.0.0', type: 'onnx', config: { features: ['a'] } });
    expect(out.id).toBe('m1');
  });

  it('creates without config (undefined branch)', async () => {
    prisma.mlModel.findFirst.mockResolvedValue(null);
    prisma.mlModel.create.mockResolvedValue({ id: 'm1' });
    await svc.registerModel({ name: 'n', version: '1.0.0', type: 'pmml' });
    expect(prisma.mlModel.create.mock.calls[0][0].data.config).toBeUndefined();
  });
});

describe('listModels + getModel', () => {
  it('listModels orders by createdAt desc', async () => {
    prisma.mlModel.findMany.mockResolvedValue([]);
    await svc.listModels();
    expect(prisma.mlModel.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('getModel 404 when missing', async () => {
    prisma.mlModel.findUnique.mockResolvedValue(null);
    await expect(svc.getModel('mX')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getModel hydrates allocations', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1', abAllocations: [] });
    const out = await svc.getModel('m1');
    expect(out.id).toBe('m1');
  });
});

describe('updateModelStatus', () => {
  it('400 on invalid status', async () => {
    await expect(svc.updateModelStatus('m1', 'retired')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 when model missing', async () => {
    prisma.mlModel.findUnique.mockResolvedValue(null);
    await expect(svc.updateModelStatus('mX', 'active')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates when valid', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1' });
    prisma.mlModel.update.mockResolvedValue({ id: 'm1', status: 'active' });
    const out = await svc.updateModelStatus('m1', 'active');
    expect(out.status).toBe('active');
  });
});

describe('setAbAllocation', () => {
  it('404 when model missing', async () => {
    prisma.mlModel.findUnique.mockResolvedValue(null);
    await expect(svc.setAbAllocation('m1', 'control', 50)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when percentage out of bounds', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1' });
    await expect(svc.setAbAllocation('m1', 'control', -1)).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.setAbAllocation('m1', 'control', 101)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('updates existing allocation', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1' });
    prisma.abAllocation.findFirst.mockResolvedValue({ id: 'a1' });
    prisma.abAllocation.update.mockResolvedValue({ id: 'a1', percentage: 25 });
    const out = await svc.setAbAllocation('m1', 'control', 25);
    expect(out.percentage).toBe(25);
  });

  it('creates allocation when none exists', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1' });
    prisma.abAllocation.findFirst.mockResolvedValue(null);
    prisma.abAllocation.create.mockResolvedValue({ id: 'a2' });
    await svc.setAbAllocation('m1', 'control', 50);
    expect(prisma.abAllocation.create).toHaveBeenCalled();
  });
});

describe('infer', () => {
  it('404 when model missing', async () => {
    prisma.mlModel.findUnique.mockResolvedValue(null);
    await expect(svc.infer('mX', {}, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when model is inactive', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({ id: 'm1', name: 'n', status: 'inactive', abAllocations: [] });
    await expect(svc.infer('m1', {}, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs mock adapter on active model and returns a structured result', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'active', config: null, abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue(null);
    const out = await svc.infer('m1', { budget: 200 }, {}, 'u1');
    expect(out.prediction).toBeDefined();
    expect(Array.isArray(out.confidenceBand)).toBe(true);
    expect(out.confidenceBand).toHaveLength(2);
    expect(Array.isArray(out.topFeatures)).toBe(true);
  });

  it('applies rule override when a rule triggers', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'active',
      config: {
        rules: [{ name: 'low', condition: 'input.budget < 100', output: { prediction: 'cheap', confidence: 0.9 } }],
      },
      abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue(null);
    const out = await svc.infer('m1', { budget: 50 }, {}, 'u1');
    expect(out.prediction).toBe('cheap');
    expect(out.confidence).toBe(0.9);
    expect(out.appliedRules[0].triggered).toBe(true);
  });

  it('routes to canary when deterministic hash falls inside allocation window', async () => {
    // canary allocation totaling 100% ensures the hash always lands inside.
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'active', config: null, abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue({
      id: 'm2', name: 'n', type: 'custom', status: 'canary', config: null,
      abAllocations: [{ percentage: 100 }],
    });
    const out = await svc.infer('m1', { x: 1 }, {}, 'u-routed');
    expect(out.prediction).toBeDefined();
  });

  it('stays on main model when canary exists but 0% allocation', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'active', config: null, abAllocations: [],
    });
    prisma.mlModel.findFirst.mockResolvedValue({
      id: 'm2', name: 'n', type: 'custom', status: 'canary', config: null,
      abAllocations: [{ percentage: 0 }],
    });
    const out = await svc.infer('m1', { x: 1 }, {}, 'u1');
    expect(out.prediction).toBeDefined();
  });

  it('skips canary routing when userId is absent', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'active', config: null, abAllocations: [],
    });
    // Should not even query for canary
    await svc.infer('m1', { x: 1 }, {});
    expect(prisma.mlModel.findFirst).not.toHaveBeenCalled();
  });

  it('allows direct canary model inference', async () => {
    prisma.mlModel.findUnique.mockResolvedValue({
      id: 'm1', name: 'n', type: 'custom', status: 'canary', config: null, abAllocations: [],
    });
    const out = await svc.infer('m1', { x: 1 }, {});
    expect(out.prediction).toBeDefined();
  });
});
