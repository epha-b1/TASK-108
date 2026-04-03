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
