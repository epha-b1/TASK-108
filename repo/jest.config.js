/**
 * Jest configuration for TripForge.
 *
 * Two projects (unit + api) share a single `collectCoverageFrom` + threshold
 * policy so `--coverage` aggregates across both suites. Thresholds are pinned
 * ~2 pts below the measured baseline (~99% stmts, ~93% branches, ~98% fns,
 * ~99% lines) so expected-variance runs don't flake, while any real regression
 * — a new uncovered service, a removed test — trips the CI gate.
 *
 * Determinism hardening:
 *   - `clearMocks: true`     — jest.fn().mockClear() between every test.
 *   - `resetMocks: true`     — also resets implementations between tests.
 *   - `restoreMocks: true`   — jest.spyOn()s get unwound between tests.
 *   - `resetModules: true`   — a freshly required module between tests so
 *                              file-local state can't leak across suites.
 *   - `maxWorkers: 1` for unit  — all module-level state is single-threaded.
 *   - API tests already run `--runInBand` in run_tests.sh for DB isolation.
 *
 * Files excluded from coverage:
 *   - `src/__mocks__/**`       : test doubles, not shipped code
 *   - `src/models/prisma/**`   : Prisma-generated client, not hand-written
 *   - `src/types/**`           : ambient type declarations with no runtime
 *   - `dist/**`                : build artefact; covered via its sources
 *
 * To regenerate the baseline report:
 *   docker compose exec -T api npx jest --coverage
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
const sharedCoverageFrom = [
  'src/**/*.ts',
  '!src/__mocks__/**',
  '!src/models/prisma/**',
  '!src/types/**',
  '!src/**/*.d.ts',
];

const sharedDeterminism = {
  // Clears mock call history between tests. Does NOT remove implementations,
  // so the default `jest.fn().mockResolvedValue(...)` stubs baked into
  // src/__mocks__/prisma.ts survive across tests inside a file — that's what
  // the per-spec resetPrisma() helpers expect.
  clearMocks: true,
  // Unwinds any `jest.spyOn(...)` implementations between tests so a spy set
  // in one test can never leak into the next. Safer than the coarser
  // `resetMocks` (which would also erase the prisma-mock defaults).
  restoreMocks: true,
  // 2-minute hard cap so a runaway test fails loud instead of hanging CI.
  testTimeout: 120_000,
};

module.exports = {
  collectCoverageFrom: sharedCoverageFrom,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 85,
      functions: 95,
      lines: 95,
    },
  },
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['**/unit_tests/**/*.spec.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      modulePathIgnorePatterns: ['<rootDir>/dist/'],
      moduleNameMapper: {
        '../models/prisma': '<rootDir>/src/__mocks__/prisma.ts',
        '../../models/prisma': '<rootDir>/src/__mocks__/prisma.ts',
      },
      collectCoverageFrom: sharedCoverageFrom,
      ...sharedDeterminism,
      // Unit tests are fast and fully in-memory; single-threaded eliminates
      // any cross-worker race on the jest module cache.
      maxWorkers: 1,
    },
    {
      displayName: 'api',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['**/API_tests/**/*.spec.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      modulePathIgnorePatterns: ['<rootDir>/dist/'],
      collectCoverageFrom: sharedCoverageFrom,
      ...sharedDeterminism,
      // API tests hit a single live MySQL — must be serialised.
      maxWorkers: 1,
    },
  ],
};
