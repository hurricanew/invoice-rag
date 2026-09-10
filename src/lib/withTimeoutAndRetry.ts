export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`${toolName} timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

export interface WithTimeoutAndRetryOptions {
  timeoutMs: number;
  maxRetries: number;
  toolName: string;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Bounded retry for transient failures (timeout, thrown error from the tool
// itself) — distinct from output-validation retries, which are a separate
// concern handled in llmDecisionWithRepair. A tool that keeps failing after
// maxRetries throws its last error rather than retrying indefinitely.
export async function withTimeoutAndRetry<T>(
  fn: () => Promise<T>,
  options: WithTimeoutAndRetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
    try {
      return await raceWithTimeout(fn(), options.timeoutMs, options.toolName);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
