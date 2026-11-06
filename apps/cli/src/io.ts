/** `ks` exit codes: 0 success; 1 the command ran but its quality gate failed; 2 usage, auth, network or executor error. */
export const EXIT = Object.freeze({ ok: 0, gateFailed: 1, error: 2 } as const);

/** The process surface `ks` writes to and reads configuration from; tests supply their own. */
export interface KsIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** A malformed invocation: exit 2 with a usage message, before anything runs. */
export class KsUsageError extends Error {
  override readonly name = "KsUsageError";
}
