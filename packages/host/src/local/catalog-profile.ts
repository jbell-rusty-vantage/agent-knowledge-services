import type { CatalogOperation } from "@aiengineer/knowledge-application";
import { profileAvailability, type ProfileAvailability } from "./capabilities.js";

/** What the local host profile admits for this catalog operation. */
export function localProfileState(operation: CatalogOperation): Exclude<ProfileAvailability, "server" | "remote"> {
  const state = profileAvailability("local", operation.executor?.mcp ?? operation.id);
  if (state === "server" || state === "remote") throw new Error(`UNEXPECTED_LOCAL_STATE:${operation.id}`);
  return state;
}
