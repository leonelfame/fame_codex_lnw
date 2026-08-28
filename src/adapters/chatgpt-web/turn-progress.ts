export interface ChatGptExternalTurnProgressSnapshot {
  revision: number;
  lastToolBatchRevision: number;
  activeToolCalls: number;
  lastProgressAt?: number;
}

interface ProgressWaiter {
  afterRevision: number;
  resolve: (snapshot: ChatGptExternalTurnProgressSnapshot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Carries only proven Codex MCP activity into the browser worker.
 *
 * It is deliberately not a completion channel: browser-visible text and terminal state remain
 * owned by the ChatGPT DOM. A valid current-turn tool request only proves that submission was
 * accepted and that the model is still making progress while its DOM is temporarily unavailable.
 */
export class ChatGptExternalTurnProgress {
  private revision = 0;
  private lastToolBatchRevision = 0;
  private activeToolCalls = 0;
  private lastProgressAt?: number;
  private readonly waiters = new Set<ProgressWaiter>();

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return {
      revision: this.revision,
      lastToolBatchRevision: this.lastToolBatchRevision,
      activeToolCalls: this.activeToolCalls,
      ...(this.lastProgressAt !== undefined ? { lastProgressAt: this.lastProgressAt } : {}),
    };
  }

  recordToolBatch(count: number, now = Date.now()): void {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("ChatGPT external progress requires a non-empty tool batch");
    }
    this.activeToolCalls += count;
    this.advance(now, "tool_batch");
  }

  recordToolResult(now = Date.now()): void {
    if (this.activeToolCalls <= 0) {
      throw new Error("ChatGPT external progress received a tool result without an active call");
    }
    this.activeToolCalls -= 1;
    this.advance(now, "tool_result");
  }

  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("ChatGPT external progress revision must be a non-negative safe integer");
    }
    const current = this.snapshot();
    if (current.revision > afterRevision) return Promise.resolve(current);
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ProgressWaiter = { afterRevision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  private advance(now: number, event: "tool_batch" | "tool_result"): void {
    if (!Number.isFinite(now)) throw new Error("ChatGPT external progress timestamp must be finite");
    this.revision += 1;
    if (event === "tool_batch") this.lastToolBatchRevision = this.revision;
    this.lastProgressAt = now;
    const snapshot = this.snapshot();
    for (const waiter of [...this.waiters]) {
      if (snapshot.revision <= waiter.afterRevision) continue;
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(snapshot);
    }
  }
}

export function chatGptExternalProgressIsLive(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!snapshot) return false;
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("ChatGPT external progress liveness inputs are invalid");
  }
  return snapshot.activeToolCalls > 0
    || (snapshot.lastProgressAt !== undefined && now - snapshot.lastProgressAt < graceMs);
}
