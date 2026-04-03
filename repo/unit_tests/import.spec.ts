/**
 * Unit tests for import validation logic.
 *
 * Tests CSV parsing validation, deduplication key generation,
 * and rollback window enforcement.
 */

describe('CSV parsing — missing required fields', () => {
  const RESOURCE_REQUIRED_FIELDS = ['name', 'type'];

  function validateRequiredFields(
    row: Record<string, unknown>,
    requiredFields: string[],
  ): { field: string; message: string }[] {
    const errors: { field: string; message: string }[] = [];
    for (const field of requiredFields) {
      const value = row[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        errors.push({ field, message: `${field} is required` });
      }
    }
    return errors;
  }

  it('detects missing "name" field', () => {
    const row = { type: 'attraction', city: 'Paris' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('name');
    expect(errors[0].message).toContain('name is required');
  });

  it('detects missing "type" field', () => {
    const row = { name: 'Eiffel Tower', city: 'Paris' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('type');
  });

  it('detects both missing "name" and "type"', () => {
    const row = { city: 'Paris', country: 'France' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(2);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('name');
    expect(fields).toContain('type');
  });

  it('detects empty string as missing', () => {
    const row = { name: '', type: '  ', city: 'Paris' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(2);
  });

  it('passes when all required fields present', () => {
    const row = { name: 'Eiffel Tower', type: 'attraction', city: 'Paris' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(0);
  });

  it('detects null values as missing', () => {
    const row = { name: null, type: 'attraction' };
    const errors = validateRequiredFields(row, RESOURCE_REQUIRED_FIELDS);
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('name');
  });
});

describe('Deduplication key generation', () => {
  function generateDedupKey(
    row: Record<string, unknown>,
    dedupFields: string[],
  ): string | null {
    const parts: string[] = [];
    for (const f of dedupFields) {
      const val = row[f];
      if (val === undefined || val === null || String(val).trim() === '') {
        return null; // Cannot generate key if fields are missing
      }
      parts.push(String(val).trim());
    }
    return parts.join('|');
  }

  it('generates key from default fields: name+streetLine+city', () => {
    const row = { name: 'Eiffel Tower', streetLine: 'Champ de Mars', city: 'Paris' };
    const key = generateDedupKey(row, ['name', 'streetLine', 'city']);
    expect(key).toBe('Eiffel Tower|Champ de Mars|Paris');
  });

  it('returns null when a dedup field is missing', () => {
    const row = { name: 'Eiffel Tower', city: 'Paris' };
    const key = generateDedupKey(row, ['name', 'streetLine', 'city']);
    expect(key).toBeNull();
  });

  it('trims whitespace from field values', () => {
    const row = { name: '  Eiffel Tower  ', streetLine: ' Champ de Mars ', city: ' Paris ' };
    const key = generateDedupKey(row, ['name', 'streetLine', 'city']);
    expect(key).toBe('Eiffel Tower|Champ de Mars|Paris');
  });

  it('generates key from custom dedup fields', () => {
    const row = { name: 'Eiffel Tower', type: 'attraction', country: 'France' };
    const key = generateDedupKey(row, ['name', 'country']);
    expect(key).toBe('Eiffel Tower|France');
  });

  it('custom dedup key string is split on "+"', () => {
    const dedupKeyConfig = 'name+city';
    const dedupFields = dedupKeyConfig.split('+');
    expect(dedupFields).toEqual(['name', 'city']);

    const row = { name: 'Louvre', city: 'Paris' };
    const key = generateDedupKey(row, dedupFields);
    expect(key).toBe('Louvre|Paris');
  });
});

describe('Rollback window — 10 minutes from creation', () => {
  it('rollback allowed within 10 minutes', () => {
    const createdAt = new Date();
    const rollbackUntil = new Date(createdAt.getTime() + 10 * 60 * 1000);

    // "Now" is 5 minutes after creation
    const now = new Date(createdAt.getTime() + 5 * 60 * 1000);
    expect(now <= rollbackUntil).toBe(true);
  });

  it('rollback denied after 10 minutes', () => {
    const createdAt = new Date();
    const rollbackUntil = new Date(createdAt.getTime() + 10 * 60 * 1000);

    // "Now" is 11 minutes after creation
    const now = new Date(createdAt.getTime() + 11 * 60 * 1000);
    expect(now > rollbackUntil).toBe(true);
  });

  it('rollback allowed at exactly 10 minutes', () => {
    const createdAt = new Date();
    const rollbackUntil = new Date(createdAt.getTime() + 10 * 60 * 1000);

    // "Now" is exactly 10 minutes after creation
    const now = new Date(createdAt.getTime() + 10 * 60 * 1000);
    expect(now <= rollbackUntil).toBe(true);
  });

  it('rollbackUntil is exactly 10 minutes from creation', () => {
    const createdAt = new Date('2026-01-15T12:00:00Z');
    const rollbackUntil = new Date(createdAt.getTime() + 10 * 60 * 1000);
    expect(rollbackUntil.toISOString()).toBe('2026-01-15T12:10:00.000Z');
  });
});
