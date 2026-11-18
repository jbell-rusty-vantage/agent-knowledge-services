/**
 * The administrator DSN that integration tests and proof scripts may use to create, install into and drop
 * disposable databases (SPEC-03 K3: local by default). `KS_AIENG_DB_ADMIN_DSN` is accepted only when it points at a
 * loopback host; a remote value (the owner's Supabase admin login, for example) is refused instead of reached.
 */
export const DISPOSABLE_ADMIN_DSN_VARIABLE = "KS_AIENG_DB_ADMIN_DSN";

const LOOPBACK = /^(?:localhost|.+\.localhost|::1|127(?:\.\d{1,3}){3})$/;

/** `undefined` when the variable is unset or blank (the caller skips); the DSN when it is loopback; otherwise throws. */
export function disposableAdminDsn(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = environment[DISPOSABLE_ADMIN_DSN_VARIABLE]?.trim();
  if (!value) return undefined;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new Error(`DISPOSABLE_ADMIN_DSN_INVALID: ${DISPOSABLE_ADMIN_DSN_VARIABLE} is not a parseable DSN`);
  }
  if (!LOOPBACK.test(host))
    throw new Error(
      `DISPOSABLE_ADMIN_DSN_REMOTE_REFUSED: ${DISPOSABLE_ADMIN_DSN_VARIABLE} points at a remote host; these tests create and drop databases, so unset it or point it at a loopback PostgreSQL (the sprint-v-pg17 container)`,
    );
  return value;
}
