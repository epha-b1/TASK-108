/**
 * Comprehensive coverage for `src/services/import.service.ts` beyond the
 * existing spec (which focused on dedup parsing and state-machine guards).
 * This suite drives:
 *   - getTemplateColumns for both entity types and the unsupported-type error
 *   - downloadTemplate in both csv + xlsx formats
 *   - uploadAndValidate end-to-end for CSV + XLSX, with required-field and
 *     type-specific validation + DB deduplication and empty/unsupported-file
 *     branches
 *   - commitBatch happy paths for both entity types AND its four guard
 *     conditions
 *   - rollbackBatch happy path, window-expired guard, and the 404/403 guards
 *   - getBatchStatus ownership enforcement branches
 */

import ExcelJS from 'exceljs';
import * as svc from '../src/services/import.service';
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

/* ========== Template download ========== */

describe('getTemplateColumns', () => {
  it('returns resource columns', () => {
    const cols = svc.getTemplateColumns('resources');
    expect(cols.map((c) => c.header)).toEqual([
      'name', 'type', 'streetLine', 'city', 'region', 'country', 'latitude', 'longitude', 'minDwellMinutes',
    ]);
  });
  it('returns itinerary columns', () => {
    const cols = svc.getTemplateColumns('itineraries');
    expect(cols.map((c) => c.header)).toEqual(['title', 'destination', 'startDate', 'endDate', 'status']);
  });
  it('400 for unsupported entity type', () => {
    expect(() => svc.getTemplateColumns('bogus')).toThrow(/Unsupported entity type/);
  });
});

describe('downloadTemplate', () => {
  it('csv header-only file for resources', async () => {
    const out = await svc.downloadTemplate('resources', 'csv');
    expect(out.format).toBe('csv');
    expect(out.contentType).toContain('text/csv');
    expect(out.filename).toBe('resources-template.csv');
    expect(out.body.toString('utf-8')).toMatch(/^name,type,streetLine/);
    expect(out.body.toString('utf-8').endsWith('\r\n')).toBe(true);
  });

  it('xlsx default format produces a parseable workbook', async () => {
    const out = await svc.downloadTemplate('itineraries');
    expect(out.format).toBe('xlsx');
    expect(out.filename).toBe('itineraries-template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.body as unknown as ExcelJS.Buffer);
    const sheet = wb.worksheets[0];
    const row1Values = (sheet.getRow(1).values as string[]).filter(Boolean);
    expect(row1Values).toEqual(['title', 'destination', 'startDate', 'endDate', 'status']);
  });

  it('400 for unsupported entity type', async () => {
    await expect(svc.downloadTemplate('bogus', 'csv')).rejects.toMatchObject({ statusCode: 400 });
  });
});

/* ========== uploadAndValidate ========== */

function csvBuf(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf-8');
}

describe('uploadAndValidate', () => {
  it('returns the existing batch when idempotencyKey is replayed', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b-old', errors: [] });
    const result: any = await svc.uploadAndValidate(
      'u1',
      { buffer: csvBuf(['name,type']), originalname: 'r.csv' },
      'resources',
      'idem-1',
    );
    expect(result.id).toBe('b-old');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('400 for unsupported entity type', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(
      svc.uploadAndValidate('u1', { buffer: csvBuf([]), originalname: 'r.csv' }, 'bogus', 'k'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 for unknown file format', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(
      svc.uploadAndValidate('u1', { buffer: Buffer.from(''), originalname: 'r.txt' }, 'resources', 'k'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 for empty file', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(
      svc.uploadAndValidate('u1', { buffer: csvBuf(['name,type']), originalname: 'r.csv' }, 'resources', 'k'),
    ).rejects.toMatchObject({ statusCode: 400, message: /no data/ });
  });

  it('records per-row errors for bad resource rows (latitude, longitude, dwell, type)', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    prisma.resource.findFirst.mockResolvedValue(null);
    prisma.importBatch.create.mockResolvedValue({ id: 'b1' });
    prisma.importError.createMany.mockResolvedValue({});
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null) // idempotency check
      .mockResolvedValueOnce({ id: 'b1', errors: [] });
    await svc.uploadAndValidate(
      'u1',
      {
        buffer: csvBuf([
          'name,type,latitude,longitude,minDwellMinutes',
          'A,attraction,999,-500,not-a-number',
          'B,unknown_type,1,1,30',
          ',lodging,0,0,30', // missing name
        ]),
        originalname: 'r.csv',
      },
      'resources',
      'k-1',
    );
    expect(prisma.importError.createMany).toHaveBeenCalled();
    const errors = prisma.importError.createMany.mock.calls[0][0].data;
    const fields = errors.map((e: any) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['latitude', 'longitude', 'minDwellMinutes', 'type', 'name']));
  });

  it('flags DB-level duplicates for resources', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null) // idempotency check
      .mockResolvedValueOnce({ id: 'b1', errors: [] });
    prisma.resource.findFirst.mockResolvedValue({ id: 'existing-r' });
    prisma.importBatch.create.mockResolvedValue({ id: 'b1' });
    prisma.importError.createMany.mockResolvedValue({});
    await svc.uploadAndValidate(
      'u1',
      {
        buffer: csvBuf([
          'name,type,streetLine,city',
          'Cafe,meal,Main 1,Rome',
        ]),
        originalname: 'r.csv',
      },
      'resources',
      'k-dup',
      'name,streetLine,city',
    );
    const errors = prisma.importError.createMany.mock.calls[0][0].data;
    const dupErr = errors.find((e: any) => e.message.includes('Duplicate'));
    expect(dupErr).toBeDefined();
  });

  it('skips dedup when dedup field is empty/missing in the row', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', errors: [] });
    prisma.resource.findFirst.mockResolvedValue(null);
    prisma.importBatch.create.mockResolvedValue({ id: 'b1' });
    await svc.uploadAndValidate(
      'u1',
      {
        buffer: csvBuf([
          'name,type',
          'A,attraction',
        ]),
        originalname: 'r.csv',
      },
      'resources',
      'k-skip',
      'name,streetLine,city', // streetLine + city missing in row
    );
    expect(prisma.resource.findFirst).not.toHaveBeenCalled();
  });

  it('validates itinerary rows for date + status', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', errors: [] });
    prisma.importBatch.create.mockResolvedValue({ id: 'b1' });
    prisma.importError.createMany.mockResolvedValue({});
    await svc.uploadAndValidate(
      'u1',
      {
        buffer: csvBuf([
          'title,startDate,endDate,status',
          'Trip,not-a-date,also-bad,pending',
        ]),
        originalname: 'it.csv',
      },
      'itineraries',
      'k-it',
    );
    const errors = prisma.importError.createMany.mock.calls[0][0].data;
    const fields = errors.map((e: any) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['startDate', 'endDate', 'status']));
  });

  it('accepts valid itinerary rows and creates a batch', async () => {
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', errors: [] });
    prisma.importBatch.create.mockResolvedValue({ id: 'b1' });
    const out: any = await svc.uploadAndValidate(
      'u1',
      { buffer: csvBuf(['title', 'Trip']), originalname: 'it.csv' },
      'itineraries',
      'k-ok',
    );
    expect(out.id).toBe('b1');
    const createCall = prisma.importBatch.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('validated');
    expect(createCall.data.totalRows).toBe(1);
  });

  it('handles xlsx upload through parseExcelToRows', async () => {
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet('resources');
    sh.columns = [
      { header: 'name', key: 'name' },
      { header: 'type', key: 'type' },
    ];
    sh.addRow({ name: 'A', type: 'attraction' });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    prisma.importBatch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b2', errors: [] });
    prisma.importBatch.create.mockResolvedValue({ id: 'b2' });
    prisma.resource.findFirst.mockResolvedValue(null);
    const out: any = await svc.uploadAndValidate(
      'u1',
      { buffer: buf, originalname: 'r.xlsx' },
      'resources',
      'k-xlsx',
    );
    expect(out.id).toBe('b2');
  });
});

/* ========== commitBatch ========== */

describe('commitBatch', () => {
  it('404 when missing', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(svc.commitBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when not owner', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u2', status: 'validated' });
    await expect(svc.commitBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 for completed, rolled_back, and other statuses', async () => {
    for (const status of ['completed', 'rolled_back', 'pending']) {
      prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u1', status });
      await expect(svc.commitBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('400 when validated data is empty', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'validated', validatedData: [],
    });
    await expect(svc.commitBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 when no valid rows', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'validated',
      validatedData: [{ rowNumber: 2, data: {}, valid: false, errors: [] }],
    });
    await expect(svc.commitBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('commits resources and records importedIds', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'validated', entityType: 'resources',
      validatedData: [
        { rowNumber: 2, valid: true, errors: [], data: {
          name: 'A', type: 'attraction', streetLine: 'St 1', city: 'Rome',
          region: 'Lazio', country: 'IT', latitude: '41.9', longitude: '12.5', minDwellMinutes: '45',
        } },
        { rowNumber: 3, valid: true, errors: [], data: { name: 'B', type: 'meal' } },
      ],
    });
    prisma.resource.create.mockResolvedValueOnce({ id: 'r1' }).mockResolvedValueOnce({ id: 'r2' });
    prisma.importBatch.update.mockResolvedValue({ id: 'b1', status: 'completed' });
    await svc.commitBatch('b1', 'u1');
    expect(prisma.resource.create).toHaveBeenCalledTimes(2);
    const updData = prisma.importBatch.update.mock.calls[0][0].data;
    expect(updData.status).toBe('completed');
    expect(updData.successRows).toBe(2);
  });

  it('commits itineraries', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b2', userId: 'u1', status: 'validated', entityType: 'itineraries',
      validatedData: [
        { rowNumber: 2, valid: true, errors: [], data: {
          title: 'Trip', destination: 'Italy', startDate: '2026-06-01', endDate: '2026-06-07', status: 'Draft',
        } },
      ],
    });
    prisma.itinerary.create.mockResolvedValue({ id: 'i1' });
    prisma.importBatch.update.mockResolvedValue({ id: 'b2', status: 'completed' });
    await svc.commitBatch('b2', 'u1');
    const data = prisma.itinerary.create.mock.calls[0][0].data;
    expect(data.title).toBe('Trip');
    expect(data.status).toBe('draft');
  });
});

/* ========== rollbackBatch ========== */

describe('rollbackBatch', () => {
  it('404 when missing', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(svc.rollbackBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when not owner', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u2', status: 'completed' });
    await expect(svc.rollbackBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('409 when batch is not completed', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u1', status: 'validated' });
    await expect(svc.rollbackBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('409 when rollback window expired', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'completed',
      rollbackUntil: new Date(Date.now() - 60_000),
    });
    await expect(svc.rollbackBatch('b1', 'u1')).rejects.toMatchObject({ statusCode: 409, message: /window/ });
  });

  it('rolls back resources (deleteMany + status=rolled_back)', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'completed', entityType: 'resources',
      rollbackUntil: new Date(Date.now() + 60_000),
      validatedData: { importedIds: ['r1', 'r2'] },
    });
    prisma.resource.deleteMany.mockResolvedValue({});
    prisma.importBatch.update.mockResolvedValue({ id: 'b1', status: 'rolled_back' });
    await svc.rollbackBatch('b1', 'u1');
    expect(prisma.resource.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] } } });
  });

  it('rolls back itineraries', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'completed', entityType: 'itineraries',
      rollbackUntil: new Date(Date.now() + 60_000),
      validatedData: { importedIds: ['i1'] },
    });
    prisma.itinerary.deleteMany.mockResolvedValue({});
    prisma.importBatch.update.mockResolvedValue({ id: 'b1', status: 'rolled_back' });
    await svc.rollbackBatch('b1', 'u1');
    expect(prisma.itinerary.deleteMany).toHaveBeenCalled();
  });

  it('handles empty importedIds (noop delete)', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'completed', entityType: 'resources',
      rollbackUntil: new Date(Date.now() + 60_000),
      validatedData: null,
    });
    prisma.importBatch.update.mockResolvedValue({ id: 'b1', status: 'rolled_back' });
    await svc.rollbackBatch('b1', 'u1');
    expect(prisma.resource.deleteMany).not.toHaveBeenCalled();
  });
});

/* ========== getBatchStatus ========== */

describe('getBatchStatus', () => {
  it('404 when batch missing', async () => {
    prisma.importBatch.findUnique.mockResolvedValue(null);
    await expect(svc.getBatchStatus('b1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('403 when non-admin requests another user\'s batch', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u2' });
    await expect(svc.getBatchStatus('b1', 'u1', 'organizer')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admin can read any batch', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u2' });
    const out = await svc.getBatchStatus('b1', 'u1', 'admin');
    expect(out.id).toBe('b1');
  });

  it('owner can read own batch', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const out = await svc.getBatchStatus('b1', 'u1', 'organizer');
    expect(out.id).toBe('b1');
  });

  it('reads without user context (internal call)', async () => {
    prisma.importBatch.findUnique.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const out = await svc.getBatchStatus('b1');
    expect(out.id).toBe('b1');
  });
});
