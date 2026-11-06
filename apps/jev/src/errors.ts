import { JevError } from "@aiengineer/knowledge-contracts/jev";

export function publicErrorCode(error: unknown): string {
  return error instanceof JevError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : "JEV_REQUEST_FAILED";
}
