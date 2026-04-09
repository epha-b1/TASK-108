/**
 * Tests for src/config/environment.ts.
 *
 * The environment loader is the gatekeeper that prevents the server from
 * booting with weak / placeholder secrets in any non-test runtime. These tests
 * exercise loadEnvironment() under the three regimes that matter:
 *
 *   1. NODE_ENV=test         -> safe deterministic defaults are accepted.
 *   2. NODE_ENV=production    -> missing values throw EnvironmentConfigError.
 *   3. NODE_ENV=production    -> known weak / too-short values throw.
 *
 * We restore process.env between tests so the rest of the suite continues to
 * see the test-mode defaults.
 */

import {
  loadEnvironment,
  EnvironmentConfigError,
  MIN_JWT_SECRET_LENGTH,
  REQUIRED_ENCRYPTION_KEY_LENGTH,
} from '../src/config/environment';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
}

describe('loadEnvironment — NODE_ENV=test', () => {
  beforeEach(() => {
    resetEnv();
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => resetEnv());
  afterAll(() => resetEnv());

  it('returns deterministic defaults when secrets are unset', () => {
    const cfg = loadEnvironment();
    expect(cfg.jwtSecret.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
    expect(cfg.encryptionKey.length).toBe(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(cfg.databaseUrl).toContain('mysql://');
  });

  it('still rejects an explicitly-set known-weak JWT_SECRET in test mode', () => {
    process.env.JWT_SECRET = 'change_me_in_production';
    expect(() => loadEnvironment()).toThrow(EnvironmentConfigError);
  });
});

describe('loadEnvironment — NODE_ENV=production', () => {
  beforeEach(() => {
    resetEnv();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'mysql://u:p@db:3306/tripforge';
  });

  afterEach(() => resetEnv());
  afterAll(() => resetEnv());

  it('throws when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    process.env.ENCRYPTION_KEY = 'a'.repeat(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(() => loadEnvironment()).toThrow(/JWT_SECRET is required/);
  });

  it('throws when ENCRYPTION_KEY is missing', () => {
    process.env.JWT_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadEnvironment()).toThrow(/ENCRYPTION_KEY is required/);
  });

  it('throws when JWT_SECRET is shorter than the minimum', () => {
    process.env.JWT_SECRET = 'too-short';
    process.env.ENCRYPTION_KEY = 'a'.repeat(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(() => loadEnvironment()).toThrow(/at least 32 characters/);
  });

  it('throws when ENCRYPTION_KEY length is wrong', () => {
    process.env.JWT_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => loadEnvironment()).toThrow(/exactly 32/);
  });

  it('throws when JWT_SECRET is the legacy placeholder literal', () => {
    process.env.JWT_SECRET = 'change_me_in_production';
    process.env.ENCRYPTION_KEY = 'a'.repeat(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(() => loadEnvironment()).toThrow(/insecure placeholder/);
  });

  it('throws when ENCRYPTION_KEY is the legacy placeholder literal', () => {
    process.env.JWT_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);
    process.env.ENCRYPTION_KEY = 'change_me_32_chars_minimum_here_x';
    expect(() => loadEnvironment()).toThrow(/insecure placeholder/);
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    process.env.JWT_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);
    process.env.ENCRYPTION_KEY = 'a'.repeat(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(() => loadEnvironment()).toThrow(/DATABASE_URL/);
  });

  it('accepts a strong configuration', () => {
    process.env.JWT_SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH + 5);
    process.env.ENCRYPTION_KEY = 'a'.repeat(REQUIRED_ENCRYPTION_KEY_LENGTH);
    expect(() => loadEnvironment()).not.toThrow();
  });
});
