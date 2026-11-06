import { sameRef } from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "../digest.js";
import type { RunManifest, VerificationRun } from "../records/run.js";

export type RunLinkCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "RUN_LINK_MISMATCH" | "REPORT_LINK_MISMATCH"; readonly reason: string };

/** Mandatory report/run link: the manifest names exactly this run, and both name the same report revision. */
export function checkRunLink(manifest: RunManifest, run: VerificationRun): RunLinkCheck {
  if (!sameRef(manifest.run, recordRef("verification_run", run))) {
    return { ok: false, code: "RUN_LINK_MISMATCH", reason: "manifest does not name this exact run record" };
  }
  if (!sameRef(manifest.report, run.report)) {
    return { ok: false, code: "REPORT_LINK_MISMATCH", reason: "manifest and run name different report revisions" };
  }
  return { ok: true };
}
