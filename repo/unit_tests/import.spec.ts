/**
 * Unit tests for the import service.
 *
 * Replaces the previous "logic-replica" file (which copy-pasted the validation
 * helpers and tested the copy) with tests that drive the REAL functions in
 * src/services/import.service.ts via the in-memory Prisma mock at
 * src/__mocks__/prisma.ts.
 *
 * What we cover:
 *   - uploadAndValidate canonical-type enforcement: legacy types fall through
 *     as row-level validation errors.
 *   - uploadAndValidate row-level required field detection.
 *   - commitBatch state-machine guards (already committed / rolled back / not validated).
 *   - rollbackBatch window enforcement.
 */

import * as importService from '../src/services/import.service';
import { getPrisma } from '../src/config/database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = getPrisma() as any;

function reset() {
  for (const model of Object.values(prisma)) {
    if (typeof model !== 'object' || model === null) continue;
    for (const fn of Object.values(model as Record<string, unknown>)) {
      if (typeof (fn as jest.Mock)?.mockReset === 'function') (fn as jest.Mock).mockReset();
    }
  }
}

beforeEach(() => reset());

function csv(rows: string[]): { buffer: Buffer; originalname: string } {
  return { buffer: Buffer.from(rows.join('\n') + '\n'), originalname: 'fixture.csv' };
}

describe('import.service.uploadAndValidate', () => {
  it('rejects legacy resource types (restaurant/hotel/transport/activity) at row level', async () => {
    // First findUnique = idempotency check (no prior batch with this key).
    // Second findUnique = re-fetch the freshly created batch with errors.
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'batch-1', errors: [] });
    prisma.resource.findFirst.mockResolvedValue(null);
    prisma.importBatch.create.mockResolvedValue({ id: 'batch-1' });
    prisma.importError.createMany.mockResolvedValue({ count: 4 });

    const file = csv([
      'name,type,city',
      'A,restaurant,X',
      'B,hotel,X',
      'C,transport,X',
      'D,activity,X',
    ]);

    await importService.uploadAndValidate('user-1', file, 'resources', 'idem-1');

    // The createMany call captures the row-level errors written for the bad rows.
    expect(prisma.importError.createMany).toHaveBeenCalled();
    const errArgs = prisma.importError.createMany.mock.calls[0][0];
    const errs = errArgs.data as Array<{ field: string; message: string }>;
    expect(errs.length).toBeGreaterThanOrEqual(4);
    for (const e of errs) {
      expect(e.field).toBe('type');
      expect(e.message).toMatch(/attraction.*lodging.*meal.*meeting/);
    }
    // Batch was still recorded so the user can fix and re-upload, but with all
    // four rows marked as errors.
    expect(prisma.importBatch.create).toHaveBeenCalled();
    const created = prisma.importBatch.create.mock.calls[0][0].data;
    expect(created.errorRows).toBe(4);
    expect(created.successRows).toBe(0);
  });

  it('accepts canonical types (attraction/lodging/meal/meeting) without row errors', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'batch-2', errors: [] });
    prisma.resource.findFirst.mockResolvedValue(null);
    prisma.importBatch.create.mockResolvedValue({ id: 'batch-2' });

    const file = csv([
      'name,type,city',
      'A,attraction,X',
      'B,lodging,Y',
      'C,meal,Z',
      'D,meeting,W',
    ]);

    await importService.uploadAndValidate('user-1', file, 'resources', 'idem-canon');

    const created = prisma.importBatch.create.mock.calls[0][0].data;
    expect(created.errorRows).toBe(0);
    expect(created.successRows).toBe(4);
    // No row-level errors → createMany is NOT called.
    expect(prisma.importError.createMany).not.toHaveBeenCalled();
  });

  it('reports missing required fields (name, type) as row errors', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'batch-3', errors: [] });
    prisma.resource.findFirst.mockResolvedValue(null);
    prisma.importBatch.create.mockResolvedValue({ id: 'batch-3' });
    prisma.importError.createMany.mockResolvedValue({ count: 1 });

    const file = csv([
      'name,type,city',
      ',attraction,X', // missing name
    ]);

    await importService.uploadAndValidate('user-1', file, 'resources', 'idem-required');

    const errs = prisma.importError.createMany.mock.calls[0][0].data as Array<{
      field: string;
      message: string;
    }>;
    expect(errs.find((e) => e.field === 'name')).toBeDefined();
  });

  it('returns the existing batch when the same idempotency key is reused', async () => {
    const existing = { id: 'cached-batch', errors: [] };
    prisma.importBatch.findUnique.mockResolvedValue(existing);

    const result = await importService.uploadAndValidate(
      'user-1',
      csv(['name,type', 'A,attraction']),
      'resources',
      'idem-replay',
    );

    expect(result).toBe(existing);
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });
});

describe('import.service.commitBatch — state-machine guards', () => {
  it('rejects committing a batch that has already been completed', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'user-1',
      status: 'completed',
      entityType: 'resources',
      validatedData: [],
      errors: [],
    });

    await expect(importService.commitBatch('b1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('rejects committing a batch that was rolled back', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'user-1',
      status: 'rolled_back',
      entityType: 'resources',
      validatedData: [],
      errors: [],
    });

    await expect(importService.commitBatch('b1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('rejects when the actor is not the owner of the batch', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'someone-else',
      status: 'validated',
      entityType: 'resources',
      validatedData: [],
      errors: [],
    });

    await expect(importService.commitBatch('b1', 'user-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });
});

describe('import.service.rollbackBatch — window enforcement', () => {
  it('rejects rollback when the 10-minute window has expired', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'user-1',
      status: 'completed',
      entityType: 'resources',
      // 1 minute in the past
      rollbackUntil: new Date(Date.now() - 60_000),
      validatedData: { importedIds: [] },
    });

    await expect(importService.rollbackBatch('b1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('rejects rollback when batch is not in completed state', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'user-1',
      status: 'validated',
      entityType: 'resources',
      rollbackUntil: new Date(Date.now() + 60_000),
      validatedData: { importedIds: [] },
    });

    await expect(importService.rollbackBatch('b1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('proceeds when within the rollback window and deletes imported rows', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'user-1',
      status: 'completed',
      entityType: 'resources',
      rollbackUntil: new Date(Date.now() + 60_000),
      validatedData: { importedIds: ['r1', 'r2'] },
    });
    prisma.resource.deleteMany.mockResolvedValue({ count: 2 });
    prisma.importBatch.update.mockResolvedValue({ id: 'b1', status: 'rolled_back' });

    await importService.rollbackBatch('b1', 'user-1');

    expect(prisma.resource.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] } },
    });
    expect(prisma.importBatch.update).toHaveBeenCalled();
  });
});
