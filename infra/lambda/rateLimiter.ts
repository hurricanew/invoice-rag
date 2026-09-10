// In-memory, per-source-IP rate limiter for the Lambda Function URL.
//
// This is a real but imperfect protection: the counter map lives in the
// Lambda execution environment's memory, which persists across warm
// invocations of the SAME container but is reset on a cold start and is
// never shared across concurrent containers. A determined attacker who
// triggers many concurrent cold starts (e.g. from many source IPs, or by
// forcing concurrency) can exceed this limit in aggregate. It is not a
// substitute for a real distributed rate limiter (API Gateway usage plan,
// or a DynamoDB/ElastiCache-backed counter) — those require Stage B
// infrastructure not yet built (see architecture.md). What this DOES stop
// cheaply: a single script/scanner hitting the URL repeatedly from one IP
// against one warm container, which is the realistic casual-abuse case for
// a short-lived demo deployment. There is no reserved-concurrency backstop
// on top of this — this AWS account's Lambda concurrency limit is only 10
// total, below the minimum needed to reserve any capacity for one
// function — so this in-handler limiter is the only rate-limiting layer.
// The real fix for a longer-lived or higher-limit account is either
// requesting a concurrency limit increase and adding
// reservedConcurrentExecutions, or moving to API Gateway with a usage plan.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export function checkRateLimit(sourceIp: string): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(sourceIp);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(sourceIp, { count: 1, windowStart: now });
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  bucket.count += 1;
  return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - bucket.count };
}

// Prevents unbounded memory growth from many distinct source IPs over a
// long-running warm container — sweep stale buckets occasionally rather
// than on every request.
let lastSweep = Date.now();
export function sweepStaleBuckets(): void {
  const now = Date.now();
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(ip);
  }
}
