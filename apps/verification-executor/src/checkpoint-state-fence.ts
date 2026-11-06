import type { FilesystemStore } from "./store.js";

const stores = new WeakMap<FilesystemStore, Map<string, { active: number; revision: number }>>();

/** Local snapshot exclusion only; durable operation outcomes remain owned by their existing services. */
export function beginExecutorStateMutation(store: FilesystemStore, runId: string | undefined): () => void {
  if (!runId) return () => {};
  let runs = stores.get(store);
  if (!runs) {
    runs = new Map();
    stores.set(store, runs);
  }
  const state = runs.get(runId) ?? { active: 0, revision: 0 };
  runs.set(runId, state);
  state.active++;
  state.revision++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      state.active--;
      state.revision++;
    }
  };
}

export function executorStateRevision(store: FilesystemStore, runIds: readonly string[]): string {
  const runs = stores.get(store);
  return runIds
    .map((id) => {
      const state = runs?.get(id);
      if (state?.active) throw new Error("CHECKPOINT_EXECUTOR_STATE_BUSY");
      return `${id}:${state?.revision ?? 0}`;
    })
    .join("|");
}
