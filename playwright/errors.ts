export class PlaywrightHttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'PlaywrightHttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PlaywrightJobError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly logs: string[];
  public readonly jobId: string;
  public readonly tookMs: number;

  constructor(options: {
    message: string;
    statusCode: number;
    jobId: string;
    tookMs: number;
    logs: string[];
    details?: unknown;
  }) {
    super(options.message);
    this.name = 'PlaywrightJobError';
    this.statusCode = options.statusCode;
    this.details = options.details;
    this.logs = options.logs;
    this.jobId = options.jobId;
    this.tookMs = options.tookMs;
  }
}

export function isPlaywrightTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { name?: string; message?: string };
  return err.name === 'TimeoutError' || /timeout/i.test(String(err.message || ''));
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
