/** Stable, safe error codes. Messages never quote request content or exception text. */
export interface AppErrorInit {
  code: string;
  message: string;
  status: number;
  retryable?: boolean;
  headers?: Record<string, string>;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly headers: Record<string, string>;
  constructor(init: AppErrorInit) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.headers = init.headers ?? {};
  }
}

export const E = {
  badRequest: (message: string, code = "invalid_request") => new AppError({ code, message, status: 400 }),
  notFound: (message = "Not found.") => new AppError({ code: "not_found", message, status: 404 }),
  forbidden: (message = "You do not have permission to do that.", code = "forbidden") => new AppError({ code, message, status: 403 }),
  conflict: (message: string, code = "conflict") => new AppError({ code, message, status: 409 }),
  gone: (message: string, code: string) => new AppError({ code, message, status: 410 }),
  tooLarge: (message: string, code = "payload_too_large") => new AppError({ code, message, status: 413 }),
  quota: (message: string, code = "storage_quota_exceeded") => new AppError({ code, message, status: 413 }),
  unavailable: (message: string, code: string) => new AppError({ code, message, status: 503, retryable: true }),
};

export function errorResponse(error: AppError, requestId: string): Response {
  return Response.json(
    { error: { code: error.code, message: error.message, requestId, retryable: error.retryable } },
    {
      status: error.status,
      headers: { "cache-control": "no-store", "x-should-retry": error.retryable ? "true" : "false", ...error.headers },
    },
  );
}
