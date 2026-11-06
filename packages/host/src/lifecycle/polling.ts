export interface PollingLoop {
  /** Stops scheduling and awaits the active run. Idempotent across concurrent callers. */
  stop(): Promise<void>;
}

/**
 * Schedules one run at a time, `pollMs` after the previous run settles. A failed
 * run is reported and scheduling continues until stopped.
 */
export function startPollingLoop(input: {
  readonly pollMs: number;
  readonly runOnce: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}): PollingLoop {
  let stopping: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;
  const schedule = () => {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      active = input
        .runOnce()
        .catch(input.onError)
        .finally(() => {
          active = undefined;
          schedule();
        });
    }, input.pollMs);
  };
  schedule();
  return {
    stop() {
      stopping ??= (async () => {
        if (timer) clearTimeout(timer);
        await active;
      })();
      return stopping;
    },
  };
}
