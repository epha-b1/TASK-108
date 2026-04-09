/**
 * Environment configuration loader for TripForge.
 *
 * Security policy:
 *   - In non-test runtimes (NODE_ENV !== 'test'), missing or weak JWT_SECRET /
 *     ENCRYPTION_KEY values cause `loadEnvironment()` to throw — the process
 *     refuses to start, so a misconfigured deployment never silently falls back
 *     to a hardcoded default.
 *   - In NODE_ENV=test we accept controlled deterministic defaults so the
 *     unit/API test suites can run without setting envs in every shell.
 *
 * Quality requirements (production):
 *   - JWT_SECRET: minimum 32 characters, must not be a known insecure literal.
 *   - ENCRYPTION_KEY: exactly 32 characters (AES-256 key length); must not be
 *     a known insecure literal.
 */

export interface EnvironmentConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  encryptionKey: string;
  accessTokenTtl: number;
  refreshTokenTtl: number;
}

export const MIN_JWT_SECRET_LENGTH = 32;
export const REQUIRED_ENCRYPTION_KEY_LENGTH = 32;

// Test-only deterministic defaults. These must NEVER apply outside NODE_ENV=test.
export const TEST_JWT_SECRET = 'test-only-jwt-secret-do-not-use-in-prod-32+chars';
export const TEST_ENCRYPTION_KEY = 'test_only_encryption_key_32bytes';

// Block known weak / placeholder values from ever being accepted, even if a
// deployer manually re-introduces them via env vars.
const KNOWN_WEAK_SECRETS = new Set<string>([
  'change_me_in_production',
  'change_me_32_chars_minimum_here_x',
  'changeme',
  'secret',
  'password',
  'jwt_secret',
  'encryption_key',
]);

export class EnvironmentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentConfigError';
  }
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test';
}

function validateJwtSecret(value: string | undefined): string {
  if (!value || value.trim() === '') {
    if (isTestEnv()) return TEST_JWT_SECRET;
    throw new EnvironmentConfigError(
      'JWT_SECRET is required. Set a strong random value of at least ' +
        `${MIN_JWT_SECRET_LENGTH} characters before starting the server.`,
    );
  }

  if (KNOWN_WEAK_SECRETS.has(value)) {
    throw new EnvironmentConfigError(
      'JWT_SECRET is set to a known insecure placeholder value. ' +
        'Generate a strong random secret (e.g. `openssl rand -hex 32`).',
    );
  }

  if (value.length < MIN_JWT_SECRET_LENGTH) {
    throw new EnvironmentConfigError(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters ` +
        `(got ${value.length}). Generate a strong random secret.`,
    );
  }

  return value;
}

function validateEncryptionKey(value: string | undefined): string {
  if (!value || value.trim() === '') {
    if (isTestEnv()) return TEST_ENCRYPTION_KEY;
    throw new EnvironmentConfigError(
      'ENCRYPTION_KEY is required. Set a 32-character random value before ' +
        'starting the server (e.g. `openssl rand -base64 24 | cut -c1-32`).',
    );
  }

  if (KNOWN_WEAK_SECRETS.has(value)) {
    throw new EnvironmentConfigError(
      'ENCRYPTION_KEY is set to a known insecure placeholder value. ' +
        'Generate a strong random key.',
    );
  }

  if (value.length !== REQUIRED_ENCRYPTION_KEY_LENGTH) {
    throw new EnvironmentConfigError(
      `ENCRYPTION_KEY must be exactly ${REQUIRED_ENCRYPTION_KEY_LENGTH} ` +
        `characters (got ${value.length}). AES-256 requires a 32-byte key.`,
    );
  }

  return value;
}

function validateDatabaseUrl(value: string | undefined): string {
  if (!value || value.trim() === '') {
    if (isTestEnv()) {
      // Tests run inside the docker compose network where this resolves;
      // unit tests mock Prisma so the URL is never dialed.
      return 'mysql://tripforge:tripforge@db:3306/tripforge';
    }
    throw new EnvironmentConfigError('DATABASE_URL is required.');
  }
  return value;
}

export function loadEnvironment(): EnvironmentConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: validateDatabaseUrl(process.env.DATABASE_URL),
    jwtSecret: validateJwtSecret(process.env.JWT_SECRET),
    encryptionKey: validateEncryptionKey(process.env.ENCRYPTION_KEY),
    accessTokenTtl: parseInt(process.env.ACCESS_TOKEN_TTL || '1800', 10),
    refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL || '1209600', 10),
  };
}

export const env = loadEnvironment();
