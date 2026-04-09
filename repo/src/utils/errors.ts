export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const VALIDATION_ERROR = 'VALIDATION_ERROR';
export const UNAUTHORIZED = 'UNAUTHORIZED';
export const FORBIDDEN = 'FORBIDDEN';
export const NOT_FOUND = 'NOT_FOUND';
export const CONFLICT = 'CONFLICT';
export const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
export const RATE_LIMITED = 'RATE_LIMITED';
export const INTERNAL_ERROR = 'INTERNAL_ERROR';

/**
 * Stable code returned by the unusual-location challenge ISSUANCE branch of
 * POST /auth/login. The HTTP status is 429, but semantically this is "an
 * extra step is required", not "you are being throttled" — that's
 * RATE_LIMITED, used by the rate-limit branch on the same endpoint.
 *
 * The two codes are deliberately distinct so clients can disambiguate the
 * "we issued you a token, please retry with it" payload from the "you can't
 * even ask for another token right now" payload.
 */
export const CHALLENGE_REQUIRED = 'CHALLENGE_REQUIRED';
