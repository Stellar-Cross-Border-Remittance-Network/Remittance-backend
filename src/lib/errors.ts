/**
 * Application error with an HTTP status and a stable machine-readable code.
 * `code` values are part of the public API surface — do not rename.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Insufficient permissions') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE_ENTITY', message, details);
export const upstream = (message: string, details?: unknown) =>
  new AppError(502, 'UPSTREAM_ERROR', message, details);
export const internal = (message = 'Internal server error', details?: unknown) =>
  new AppError(500, 'INTERNAL_ERROR', message, details);

/** Type guard for AppError so error handlers can branch on it. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}