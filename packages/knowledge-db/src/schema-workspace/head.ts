import { infrastructureError } from "./errors.js";
import type { Workspace } from "./workspace.js";

export interface HeadCheck {
  readonly workspaceHead: string;
  readonly databaseHead: string | undefined;
  readonly matches: boolean;
}

export function compareHeads(workspace: Workspace, databaseHead: string | undefined): HeadCheck {
  return {
    workspaceHead: workspace.migrationHead,
    databaseHead,
    matches: databaseHead !== undefined && databaseHead === workspace.migrationHead,
  };
}

/** Fails closed with `HEAD_MISMATCH` unless `allowStale` is set; the check result is returned either way so callers can record it. */
export function assertHeadMatches(
  workspace: Workspace,
  databaseHead: string | undefined,
  allowStale = false,
): HeadCheck {
  const check = compareHeads(workspace, databaseHead);
  if (!check.matches && !allowStale) {
    throw infrastructureError(
      "HEAD_MISMATCH",
      `workspace migration head ${check.workspaceHead} ≠ database head ${String(check.databaseHead)}`,
      check,
    );
  }
  return check;
}
