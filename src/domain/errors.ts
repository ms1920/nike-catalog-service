/**
 * Domain error taxonomy.
 *
 * Service and domain layers throw these. The HTTP layer is the ONLY place that
 * maps them to status codes, which keeps business logic transport-agnostic —
 * the same service could be driven by a queue consumer or CLI without change.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(message: string, statusCode: number, code: ErrorCode, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' was not found`, 404, 'NOT_FOUND', { resource, id });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class InsufficientStockError extends AppError {
  constructor(sku: string, requested: number, available: number) {
    super(
      `Insufficient stock for variant '${sku}': requested ${requested}, available ${available}`,
      409,
      'INSUFFICIENT_STOCK',
      { sku, requested, available },
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * 403, not 401. The distinction is load-bearing: 401 means "we don't know who
 * you are, try authenticating", 403 means "we know exactly who you are and you
 * still can't do this". Collapsing them makes clients retry logins pointlessly.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Login failure. Deliberately does NOT distinguish "no such email" from "wrong
 * password" — a different message for each turns the login form into an account
 * enumeration oracle.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('Email or password is incorrect', 401, 'UNAUTHORIZED');
  }
}

/**
 * 412: the caller sent `If-Match` and it did not match the current version.
 *
 * This is the optimistic-concurrency rejection. Without it, two editors who both
 * loaded version 3 would each write their change and the later write would
 * silently erase the earlier one — the lost-update problem.
 */
export class PreconditionFailedError extends AppError {
  constructor(expected: string, actual: string) {
    super(
      'The resource has changed since you loaded it. Re-read it and retry.',
      412,
      'PRECONDITION_FAILED',
      { expected, actual },
    );
  }
}

/** 428: a mutation that requires `If-Match` was sent without one. */
export class PreconditionRequiredError extends AppError {
  constructor(header = 'If-Match') {
    super(
      `This request requires an ${header} header carrying the version you last read.`,
      428,
      'PRECONDITION_REQUIRED',
      { header },
    );
  }
}
