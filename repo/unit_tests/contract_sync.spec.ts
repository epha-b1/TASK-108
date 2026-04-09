/**
 * Contract sync tests.
 *
 * The TripForge API contract lives in two places:
 *   1. src/config/swagger.ts  — the live OpenAPI object served at /api/docs
 *   2. docs/api-spec.md       — the human-curated reference document
 *
 * The two MUST not drift. This suite parses both, normalises them, and asserts
 * that:
 *   - Every (path, method) pair documented in one exists in the other.
 *   - Endpoints that the audit historically flagged are now consistent:
 *       * POST /users is absent from both
 *       * GET /import/templates/:entityType is marked public in both
 *   - The shared error envelope schema lists `requestId` (the canonical field).
 *
 * The actual route table in src/routes/* must also match — that is exercised
 * by api_envelope.api.spec.ts which hits real routes.
 */

import fs from 'fs';
import path from 'path';
import { apiSpec } from '../src/config/swagger';

// js-yaml v3 — no @types installed but the API surface we need (`load`) is
// stable enough to type ad-hoc.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(input: string): unknown; safeLoad?(input: string): unknown };

interface OpenApiPaths {
  [path: string]: { [method: string]: unknown };
}

function normalisePath(p: string): string {
  // Convert OpenAPI {id} -> :id so we can compare against express style if
  // ever needed; here we standardise on the {id} form for comparison.
  return p.replace(/\{(\w+)\}/g, '{$1}');
}

function listOperations(spec: { paths: OpenApiPaths }): Set<string> {
  const ops = new Set<string>();
  for (const [p, methods] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(method.toLowerCase())) {
        ops.add(`${method.toUpperCase()} ${normalisePath(p)}`);
      }
    }
  }
  return ops;
}

const docsPath = path.resolve(__dirname, '..', '..', 'docs', 'api-spec.md');
const docsYaml = fs.readFileSync(docsPath, 'utf8');
const loader = yaml.safeLoad ?? yaml.load;
const docsSpec = loader(docsYaml) as { paths: OpenApiPaths; components?: { schemas?: Record<string, unknown> } };
const swaggerSpec = apiSpec as { paths: OpenApiPaths; components?: { schemas?: Record<string, unknown> } };

describe('API contract — swagger.ts vs docs/api-spec.md', () => {
  const swaggerOps = listOperations(swaggerSpec);
  const docsOps = listOperations(docsSpec);

  it('docs/api-spec.md has paths defined', () => {
    expect(docsOps.size).toBeGreaterThan(0);
  });

  it('swagger.ts has paths defined', () => {
    expect(swaggerOps.size).toBeGreaterThan(0);
  });

  it('every operation in swagger.ts is also in docs/api-spec.md', () => {
    const missingFromDocs = [...swaggerOps].filter((op) => !docsOps.has(op));
    expect(missingFromDocs).toEqual([]);
  });

  it('every operation in docs/api-spec.md is also in swagger.ts', () => {
    const missingFromSwagger = [...docsOps].filter((op) => !swaggerOps.has(op));
    expect(missingFromSwagger).toEqual([]);
  });
});

describe('API contract — historical audit drift items', () => {
  it('POST /users is not present in either spec (use /auth/register)', () => {
    const swaggerUsers = swaggerSpec.paths['/users'] as Record<string, unknown> | undefined;
    const docsUsers = docsSpec.paths['/users'] as Record<string, unknown> | undefined;
    expect(swaggerUsers?.post).toBeUndefined();
    expect(docsUsers?.post).toBeUndefined();
  });

  it('GET /import/templates/{entityType} is documented as public in both', () => {
    const swaggerOp = (swaggerSpec.paths['/import/templates/{entityType}'] as Record<string, { security?: unknown }>)?.get;
    const docsOp = (docsSpec.paths['/import/templates/{entityType}'] as Record<string, { security?: unknown }>)?.get;
    expect(swaggerOp).toBeDefined();
    expect(docsOp).toBeDefined();
    // security: [] (empty array) means "no auth required, override the global default"
    expect(Array.isArray(swaggerOp?.security)).toBe(true);
    expect((swaggerOp?.security as unknown[])?.length).toBe(0);
    expect(Array.isArray(docsOp?.security)).toBe(true);
    expect((docsOp?.security as unknown[])?.length).toBe(0);
  });
});

describe('API contract — error envelope canonical fields', () => {
  it('swagger.ts Error schema lists requestId', () => {
    const errorSchema = swaggerSpec.components?.schemas?.Error as { properties?: Record<string, unknown> } | undefined;
    expect(errorSchema?.properties?.requestId).toBeDefined();
  });

  it('docs/api-spec.md Error schema lists requestId', () => {
    const errorSchema = docsSpec.components?.schemas?.Error as { properties?: Record<string, unknown> } | undefined;
    expect(errorSchema?.properties?.requestId).toBeDefined();
  });
});
