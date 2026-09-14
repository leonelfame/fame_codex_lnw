import type { LogRecord } from "./types";

/** Retain diagnostics even offscreen; only the Activity view subscribes to paints. */
export function createActivityStore() {
  let records: LogRecord[] = [];
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (!listeners.size || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      listeners.forEach(listener => listener());
    }, 80);
  };
  return {
    getSnapshot: () => records,
    initialize(history: LogRecord[]) {
      records = history.slice(-300);
      notify();
    },
    append(record: LogRecord) {
      records = [...records.slice(-299), record];
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
