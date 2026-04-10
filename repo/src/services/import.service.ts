import { Prisma } from '../models/prisma';
import { getPrisma } from '../config/database';
import {
  AppError,
  NOT_FOUND,
  FORBIDDEN,
  CONFLICT,
  VALIDATION_ERROR,
} from '../utils/errors';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { RESOURCE_TYPES } from '../schemas/resource.schemas';

/* ---------- Types ---------- */

interface RowError {
  rowNumber: number;
  field: string | null;
  message: string;
  rawData: Record<string, unknown> | null;
}

interface ValidatedRow {
  rowNumber: number;
  data: Record<string, unknown>;
  valid: boolean;
  errors: RowError[];
}

/* ---------- Template Definitions ---------- */

const RESOURCE_COLUMNS = [
  { header: 'name', key: 'name', width: 30 },
  { header: 'type', key: 'type', width: 15 },
  { header: 'streetLine', key: 'streetLine', width: 40 },
  { header: 'city', key: 'city', width: 20 },
  { header: 'region', key: 'region', width: 20 },
  { header: 'country', key: 'country', width: 20 },
  { header: 'latitude', key: 'latitude', width: 15 },
  { header: 'longitude', key: 'longitude', width: 15 },
  { header: 'minDwellMinutes', key: 'minDwellMinutes', width: 18 },
];

const ITINERARY_COLUMNS = [
  { header: 'title', key: 'title', width: 30 },
  { header: 'destination', key: 'destination', width: 30 },
  { header: 'startDate', key: 'startDate', width: 15 },
  { header: 'endDate', key: 'endDate', width: 15 },
  { header: 'status', key: 'status', width: 15 },
];

const RESOURCE_REQUIRED_FIELDS = ['name', 'type'];
const ITINERARY_REQUIRED_FIELDS = ['title'];

/**
 * Default dedup field set used when the client doesn't supply
 * `deduplicationKey`. Documented in docs/api-spec.md and README.md.
 */
export const DEFAULT_RESOURCE_DEDUP_FIELDS = ['name', 'streetLine', 'city'] as const;

/**
 * Parse the multipart `deduplicationKey` field into an ordered list of
 * resource columns to dedup by.
 *
 * Canonical format is comma-separated:
 *
 *     name,streetLine,city
 *
 * For backwards compatibility we also accept the legacy `+` separator that
 * an earlier release used:
 *
 *     name+streetLine+city
 *
 * Whitespace around segments is tolerated, empty segments are dropped, and
 * an empty/missing key falls back to {@link DEFAULT_RESOURCE_DEDUP_FIELDS}.
 *
 * Exported so the unit suite can pin the parser behaviour without having to
 * spin up a real upload.
 */
export function parseDeduplicationKey(rawKey: string | null | undefined): string[] {
  if (!rawKey) return [...DEFAULT_RESOURCE_DEDUP_FIELDS];
  const trimmed = rawKey.trim();
  if (trimmed === '') return [...DEFAULT_RESOURCE_DEDUP_FIELDS];

  // Accept either separator. We split on both so a hypothetical mixed string
  // ("name,streetLine+city") still degrades gracefully into the three fields
  // it obviously meant.
  const parts = trimmed
    .split(/[,+]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return parts.length > 0 ? parts : [...DEFAULT_RESOURCE_DEDUP_FIELDS];
}

/* ---------- Helpers ---------- */

function getColumnsForEntity(entityType: string) {
  if (entityType === 'resources') return RESOURCE_COLUMNS;
  if (entityType === 'itineraries') return ITINERARY_COLUMNS;
  throw new AppError(400, VALIDATION_ERROR, `Unsupported entity type: ${entityType}`);
}

function getRequiredFields(entityType: string): string[] {
  if (entityType === 'resources') return RESOURCE_REQUIRED_FIELDS;
  if (entityType === 'itineraries') return ITINERARY_REQUIRED_FIELDS;
  return [];
}

function normalizeHeaders(headers: string[]): string[] {
  return headers.map((h) => h.trim().replace(/\s+/g, ''));
}

function validateResourceRow(row: Record<string, unknown>, rowNumber: number): RowError[] {
  const errors: RowError[] = [];

  if (row.latitude !== undefined && row.latitude !== null && row.latitude !== '') {
    const lat = Number(row.latitude);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      errors.push({ rowNumber, field: 'latitude', message: 'Latitude must be a number between -90 and 90', rawData: row });
    }
  }

  if (row.longitude !== undefined && row.longitude !== null && row.longitude !== '') {
    const lng = Number(row.longitude);
    if (isNaN(lng) || lng < -180 || lng > 180) {
      errors.push({ rowNumber, field: 'longitude', message: 'Longitude must be a number between -180 and 180', rawData: row });
    }
  }

  if (row.minDwellMinutes !== undefined && row.minDwellMinutes !== null && row.minDwellMinutes !== '') {
    const dwell = Number(row.minDwellMinutes);
    if (isNaN(dwell) || dwell < 0 || !Number.isInteger(dwell)) {
      errors.push({ rowNumber, field: 'minDwellMinutes', message: 'minDwellMinutes must be a non-negative integer', rawData: row });
    }
  }

  // Use the canonical resource type enum from src/schemas/resource.schemas.ts.
  // Previously this validator accepted attraction|restaurant|hotel|transport|
  // activity, while resource.service / schema only accepted attraction|lodging|
  // meal|meeting — so any "valid" import row outside the canonical set would
  // commit successfully but then break downstream consumers and PATCH /resources.
  const allowed: readonly string[] = RESOURCE_TYPES;
  if (row.type && !allowed.includes(String(row.type).toLowerCase())) {
    errors.push({
      rowNumber,
      field: 'type',
      message: `type must be one of: ${RESOURCE_TYPES.join(', ')}`,
      rawData: row,
    });
  }

  return errors;
}

function validateItineraryRow(row: Record<string, unknown>, rowNumber: number): RowError[] {
  const errors: RowError[] = [];

  if (row.startDate && isNaN(Date.parse(String(row.startDate)))) {
    errors.push({ rowNumber, field: 'startDate', message: 'startDate must be a valid date', rawData: row });
  }

  if (row.endDate && isNaN(Date.parse(String(row.endDate)))) {
    errors.push({ rowNumber, field: 'endDate', message: 'endDate must be a valid date', rawData: row });
  }

  const validStatuses = ['draft', 'published', 'archived'];
  if (row.status && !validStatuses.includes(String(row.status).toLowerCase())) {
    errors.push({ rowNumber, field: 'status', message: `status must be one of: ${validStatuses.join(', ')}`, rawData: row });
  }

  return errors;
}

function parseFileToRows(
  fileBuffer: Buffer,
  fileName: string,
): Record<string, unknown>[] {
  const ext = fileName.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    const records = parse(fileBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, unknown>[];
    return records;
  }

  // For Excel, we handle it separately in the async function
  throw new AppError(400, VALIDATION_ERROR, 'Use parseExcelToRows for Excel files');
}

async function parseExcelToRows(fileBuffer: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new AppError(400, VALIDATION_ERROR, 'Excel file has no worksheets');

  const rows: Record<string, unknown>[] = [];
  const headers: string[] = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell((cell, colNumber) => {
        headers[colNumber - 1] = String(cell.value ?? '').trim();
      });
      return;
    }

    const record: Record<string, unknown> = {};
    row.eachCell((cell, colNumber) => {
      const header = headers[colNumber - 1];
      if (header) {
        record[header] = cell.value;
      }
    });
    rows.push(record);
  });

  return rows;
}

/* ---------- Exports ---------- */

/**
 * Build the in-memory column list for a template download. Exported so the
 * route handler can serve a CSV variant from the same canonical schema as
 * the XLSX variant — guaranteeing the two formats stay in sync.
 */
export function getTemplateColumns(entityType: string): { header: string; key: string }[] {
  return getColumnsForEntity(entityType).map((c) => ({ header: c.header, key: c.key }));
}

export type TemplateFormat = 'xlsx' | 'csv';

export interface TemplateBundle {
  format: TemplateFormat;
  contentType: string;
  filename: string;
  body: Buffer;
}

/**
 * Render the import template for `entityType` in the requested `format`.
 *
 * Both formats share the same column ordering (drawn from
 * `getTemplateColumns`) so a CSV uploaded by the client validates against the
 * same row schema as an XLSX upload. The XLSX path is the historical
 * "Excel template" the prompt asked for; CSV was added to close the
 * audit-flagged gap that the spec also calls for a CSV template download.
 */
export async function downloadTemplate(
  entityType: string,
  format: TemplateFormat = 'xlsx',
): Promise<TemplateBundle> {
  const columns = getColumnsForEntity(entityType);

  if (format === 'csv') {
    // Header-only CSV — no data rows. RFC 4180 line endings (\r\n).
    const csv = columns.map((c) => csvEscape(c.header)).join(',') + '\r\n';
    return {
      format: 'csv',
      contentType: 'text/csv; charset=utf-8',
      filename: `${entityType}-template.csv`,
      body: Buffer.from(csv, 'utf-8'),
    };
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TripForge';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(entityType);
  sheet.columns = columns;

  // Style the header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    format: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${entityType}-template.xlsx`,
    body: Buffer.from(buffer),
  };
}

/**
 * Minimal RFC 4180 escaping for CSV header cells. Wraps fields containing
 * commas, quotes, or newlines in double quotes and escapes embedded quotes.
 */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function uploadAndValidate(
  userId: string,
  file: { buffer: Buffer; originalname: string },
  entityType: string,
  idempotencyKey: string,
  deduplicationKey?: string,
) {
  const prisma = getPrisma();

  // Check idempotency - return existing batch if key already used
  const existingBatch = await prisma.importBatch.findUnique({
    where: { idempotencyKey },
    include: { errors: true },
  });
  if (existingBatch) {
    return existingBatch;
  }

  getColumnsForEntity(entityType); // validates entity type
  const requiredFields = getRequiredFields(entityType);

  // Parse file
  const ext = file.originalname.split('.').pop()?.toLowerCase();
  let rows: Record<string, unknown>[];

  if (ext === 'csv') {
    rows = parseFileToRows(file.buffer, file.originalname);
  } else if (ext === 'xlsx' || ext === 'xls') {
    rows = await parseExcelToRows(file.buffer);
  } else {
    throw new AppError(400, VALIDATION_ERROR, 'Unsupported file format. Use CSV or Excel (.xlsx)');
  }

  if (rows.length === 0) {
    throw new AppError(400, VALIDATION_ERROR, 'File contains no data rows');
  }

  // Validate each row
  const validatedRows: ValidatedRow[] = [];
  const allErrors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2; // +2 for 1-indexed + header row
    const row = rows[i];
    const rowErrors: RowError[] = [];

    // Required field checks
    for (const field of requiredFields) {
      const value = row[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        rowErrors.push({
          rowNumber,
          field,
          message: `${field} is required`,
          rawData: row,
        });
      }
    }

    // Type-specific validation
    if (entityType === 'resources') {
      rowErrors.push(...validateResourceRow(row, rowNumber));
    } else if (entityType === 'itineraries') {
      rowErrors.push(...validateItineraryRow(row, rowNumber));
    }

    validatedRows.push({
      rowNumber,
      data: row,
      valid: rowErrors.length === 0,
      errors: rowErrors,
    });
    allErrors.push(...rowErrors);
  }

  // Deduplication check against DB.
  //
  // Canonical format for the `deduplicationKey` form field is COMMA-separated
  // (matches docs/api-spec.md and the new dedup parser test):
  //
  //     deduplicationKey=name,streetLine,city
  //
  // Earlier code parsed `+` as the separator, which produced silent dedup
  // misses for any client that followed the documented format. We now treat
  // both as valid (legacy `+` is accepted for backwards compatibility) so
  // upgrades don't break existing clients, but the canonical separator is `,`.
  if (entityType === 'resources') {
    const dedupFields = parseDeduplicationKey(deduplicationKey);
    for (const vr of validatedRows) {
      if (!vr.valid) continue;

      const where: Record<string, unknown> = {};
      let canDedup = true;
      for (const f of dedupFields) {
        const val = vr.data[f];
        if (val === undefined || val === null || String(val).trim() === '') {
          canDedup = false;
          break;
        }
        where[f] = String(val).trim();
      }

      if (canDedup) {
        const existing = await prisma.resource.findFirst({ where });
        if (existing) {
          const err: RowError = {
            rowNumber: vr.rowNumber,
            field: dedupFields.join(','),
            message: `Duplicate: a resource with the same ${dedupFields.join(', ')} already exists`,
            rawData: vr.data,
          };
          vr.errors.push(err);
          vr.valid = false;
          allErrors.push(err);
        }
      }
    }
  }

  const successRows = validatedRows.filter((r) => r.valid).length;
  const errorRows = validatedRows.filter((r) => !r.valid).length;

  // Create batch with validated data stored as JSON
  const batch = await prisma.importBatch.create({
    data: {
      userId,
      entityType,
      status: 'validated',
      totalRows: rows.length,
      successRows,
      errorRows,
      idempotencyKey,
      rollbackUntil: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
      validatedData: JSON.parse(JSON.stringify(validatedRows)),
    },
  });

  // Store row-level errors
  if (allErrors.length > 0) {
    await prisma.importError.createMany({
      data: allErrors.map((e) => ({
        batchId: batch.id,
        rowNumber: e.rowNumber,
        field: e.field,
        message: e.message,
        rawData: (e.rawData ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });
  }

  return prisma.importBatch.findUnique({
    where: { id: batch.id },
    include: { errors: true },
  });
}

export async function commitBatch(batchId: string, userId: string) {
  const prisma = getPrisma();

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { errors: true },
  });
  if (!batch) throw new AppError(404, NOT_FOUND, 'Import batch not found');
  if (batch.userId !== userId) throw new AppError(403, FORBIDDEN, 'Access denied');
  if (batch.status === 'completed') throw new AppError(409, CONFLICT, 'Batch already committed');
  if (batch.status === 'rolled_back') throw new AppError(409, CONFLICT, 'Batch has been rolled back');
  if (batch.status !== 'validated') {
    throw new AppError(409, CONFLICT, `Cannot commit batch with status: ${batch.status}`);
  }

  const validatedRows = batch.validatedData as ValidatedRow[] | null;
  if (!validatedRows || validatedRows.length === 0) {
    throw new AppError(400, VALIDATION_ERROR, 'No validated data to commit');
  }

  const validRows = validatedRows.filter((r) => r.valid);
  if (validRows.length === 0) {
    throw new AppError(400, VALIDATION_ERROR, 'No valid rows to commit');
  }

  const importedIds: string[] = [];

  if (batch.entityType === 'resources') {
    for (const row of validRows) {
      const data = row.data;
      const resource = await prisma.resource.create({
        data: {
          name: String(data.name),
          type: String(data.type).toLowerCase(),
          streetLine: data.streetLine ? String(data.streetLine) : null,
          city: data.city ? String(data.city) : null,
          region: data.region ? String(data.region) : null,
          country: data.country ? String(data.country) : null,
          latitude: data.latitude !== undefined && data.latitude !== null && data.latitude !== ''
            ? Number(data.latitude)
            : null,
          longitude: data.longitude !== undefined && data.longitude !== null && data.longitude !== ''
            ? Number(data.longitude)
            : null,
          minDwellMinutes: data.minDwellMinutes
            ? Number(data.minDwellMinutes)
            : 30,
        },
      });
      importedIds.push(resource.id);
    }
  } else if (batch.entityType === 'itineraries') {
    for (const row of validRows) {
      const data = row.data;
      const itinerary = await prisma.itinerary.create({
        data: {
          ownerId: userId,
          title: String(data.title),
          destination: data.destination ? String(data.destination) : null,
          startDate: data.startDate ? new Date(String(data.startDate)) : null,
          endDate: data.endDate ? new Date(String(data.endDate)) : null,
          status: data.status ? String(data.status).toLowerCase() : 'draft',
        },
      });
      importedIds.push(itinerary.id);
    }
  }

  // Update batch status and store imported IDs for potential rollback
  const updatedBatch = await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: 'completed',
      successRows: importedIds.length,
      completedAt: new Date(),
      validatedData: JSON.parse(JSON.stringify({
        rows: validatedRows,
        importedIds,
      })) as Prisma.InputJsonValue,
    },
    include: { errors: true },
  });

  return updatedBatch;
}

export async function rollbackBatch(batchId: string, userId: string) {
  const prisma = getPrisma();

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError(404, NOT_FOUND, 'Import batch not found');
  if (batch.userId !== userId) throw new AppError(403, FORBIDDEN, 'Access denied');
  if (batch.status !== 'completed') {
    throw new AppError(409, CONFLICT, `Cannot rollback batch with status: ${batch.status}`);
  }

  // Check rollback window
  if (new Date() > batch.rollbackUntil) {
    throw new AppError(409, CONFLICT, 'Rollback window has expired (10 minutes after commit)');
  }

  const batchData = batch.validatedData as { importedIds?: string[] } | null;
  const importedIds = batchData?.importedIds ?? [];

  if (importedIds.length > 0) {
    if (batch.entityType === 'resources') {
      await prisma.resource.deleteMany({
        where: { id: { in: importedIds } },
      });
    } else if (batch.entityType === 'itineraries') {
      await prisma.itinerary.deleteMany({
        where: { id: { in: importedIds } },
      });
    }
  }

  return prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: 'rolled_back',
    },
    include: { errors: true },
  });
}

export async function getBatchStatus(batchId: string, userId?: string, role?: string) {
  const prisma = getPrisma();

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { errors: true },
  });
  if (!batch) throw new AppError(404, NOT_FOUND, 'Import batch not found');

  // Ownership check: non-admin can only see own batches
  if (userId && role && role !== 'admin' && batch.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }

  return batch;
}
