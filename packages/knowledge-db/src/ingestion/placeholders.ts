/**
 * Plan actions reference not-yet-created rows symbolically; apply resolves the placeholders
 * once the rows exist (contract §5: `$subject:<ref>` and `$claim:<runId>/<claimId>`).
 */
const SUBJECT_PREFIX = "$subject:";
const CLAIM_PREFIX = "$claim:";

export const subjectPlaceholder = (ref: string): string => `${SUBJECT_PREFIX}${ref}`;
export const claimPlaceholder = (runId: string, claimId: string): string =>
  `${CLAIM_PREFIX}${claimKey(runId, claimId)}`;
export const claimKey = (runId: string, claimId: string): string => `${runId}/${claimId}`;

/** The subject ref inside a `$subject:` placeholder, or `undefined` for any other value. */
export function subjectRefOfPlaceholder(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith(SUBJECT_PREFIX) ? value.slice(SUBJECT_PREFIX.length) : undefined;
}
