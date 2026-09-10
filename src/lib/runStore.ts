import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunRecordSchema, type RunRecord, type RunStatus, type RunState } from "../schemas/run.js";
import { AuditEventSchema, type AuditEvent } from "../schemas/audit.js";
import type { RecommendationResult } from "../schemas/result.js";
import type { PendingApproval } from "../schemas/run.js";

// Overridable so concurrent test files (vitest runs each file in its own
// worker process by default) don't collide on the same data directory —
// withFileLock below only serializes writes within one process, it cannot
// coordinate across separate processes. Real CLI usage is single-process,
// single-command-at-a-time, so the default path is what production code
// uses; RUN_DATA_DIR is a test-only escape hatch.
//
// Resolved lazily (functions, not module-level consts) because ESM hoists
// all `import` statements above other top-level code regardless of source
// order — a test file that sets process.env.RUN_DATA_DIR textually
// between its imports still has that assignment run AFTER this module's
// top-level code if these were plain consts, silently defeating the
// isolation. Reading process.env at call time avoids that.
function getDataDir(): string {
  return process.env.RUN_DATA_DIR
    ? path.resolve(process.env.RUN_DATA_DIR)
    : path.resolve(process.cwd(), "data");
}
function getRunsPath(): string {
  return path.join(getDataDir(), "runs.local.json");
}
function getAuditPath(): string {
  return path.join(getDataDir(), "audit_events.local.json");
}

interface RunsFile {
  runs: RunRecord[];
}
interface AuditFile {
  events: AuditEvent[];
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// Write-then-rename is atomic on POSIX filesystems (rename replaces the
// target in one syscall) — a process killed mid-write leaves the old file
// intact and an orphaned .tmp file, never a truncated/corrupted target.
// This is what makes "application restart/resume" a safe recovery rather
// than a coin-flip on whatever JSON.parse happens to see.
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

// The orchestrator issues concurrent tool calls (Promise.all) that each
// append an audit event or update a run record. A naive read-modify-write
// against a shared JSON file is a lost-update race: two concurrent writers
// each read the same "before" state, and the second write silently
// clobbers the first. Serializing all reads+writes to a given file through
// one queue per path makes each read-modify-write atomic relative to other
// callers in this process — sufficient for Stage A's single-process local
// store; Stage B's DynamoDB writes are natively atomic per-item and won't
// need this.
const fileQueues = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  fileQueues.set(
    filePath,
    next.catch(() => undefined),
  );
  return next;
}

export async function createRun(caseId: string): Promise<RunRecord> {
  return withFileLock(getRunsPath(), async () => {
    const now = new Date().toISOString();
    const record: RunRecord = RunRecordSchema.parse({
      run_id: randomUUID(),
      case_id: caseId,
      status: "IN_PROGRESS",
      current_state: "RETRIEVE_DOCUMENTS",
      result: null,
      pending_approval: null,
      error: null,
      token_usage: null,
      created_at: now,
      updated_at: now,
    });

    const file = await readJson<RunsFile>(getRunsPath(), { runs: [] });
    file.runs.push(record);
    await writeJson(getRunsPath(), file);
    return record;
  });
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  const file = await readJson<RunsFile>(getRunsPath(), { runs: [] });
  return file.runs.find((r) => r.run_id === runId) ?? null;
}

// Every state transition is written before the caller advances — the
// orchestrator's source of truth for "what happened" is this store, not
// in-memory state, so a crash mid-run leaves an accurate last-known state
// rather than nothing at all.
export async function updateRun(
  runId: string,
  patch: Partial<
    Pick<
      RunRecord,
      "status" | "current_state" | "result" | "pending_approval" | "error" | "token_usage"
    >
  >,
): Promise<RunRecord> {
  return withFileLock(getRunsPath(), async () => {
    const file = await readJson<RunsFile>(getRunsPath(), { runs: [] });
    const index = file.runs.findIndex((r) => r.run_id === runId);
    if (index === -1) {
      throw new Error(`updateRun: no run found with id ${runId}`);
    }
    const updated: RunRecord = {
      ...file.runs[index],
      ...patch,
      updated_at: new Date().toISOString(),
    };
    file.runs[index] = RunRecordSchema.parse(updated);
    await writeJson(getRunsPath(), file);
    return file.runs[index];
  });
}

export async function appendAuditEvent(
  event: Omit<AuditEvent, "event_id" | "ts">,
): Promise<AuditEvent> {
  return withFileLock(getAuditPath(), async () => {
    const fullEvent: AuditEvent = AuditEventSchema.parse({
      ...event,
      event_id: randomUUID(),
      ts: new Date().toISOString(),
    });
    const file = await readJson<AuditFile>(getAuditPath(), { events: [] });
    file.events.push(fullEvent);
    await writeJson(getAuditPath(), file);
    return fullEvent;
  });
}

export async function getAuditEvents(runId: string): Promise<AuditEvent[]> {
  const file = await readJson<AuditFile>(getAuditPath(), { events: [] });
  return file.events.filter((e) => e.run_id === runId);
}

export type { RunRecord, RunStatus, RunState, PendingApproval, RecommendationResult };
