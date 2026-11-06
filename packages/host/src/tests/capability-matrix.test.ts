import { describe, expect, it } from "vitest";
import {
  localVerificationOperations,
  profileAvailability,
  type ExecutionProfile,
  type LocalOperation,
} from "../local/capabilities.js";

const profiles: readonly ExecutionProfile[] = ["server", "local", "remote-cli"];
const operations = Object.keys(localVerificationOperations) as LocalOperation[];
// Database-backed executor registry operations (one per group) and platform operations.
const serverBacked = [
  "schema_search",
  "db_read_intent",
  "ingest_apply",
  "artifact_get",
  "source_discover",
  "content_link_apply",
  "checkpoint_commit",
  "report_register",
  "recovery_submit",
  "verify_run",
  // SV-17: the retired verification chain is no local operation.
  "verify_claims",
  "verify_seal_run",
  "knowledge_retrieve_run",
];

// The remote CLI's client-only enforcement is tested in apps/cli (src/tests/remote-profile.test.ts).
describe("capability matrix", () => {
  it("classifies the capture and artifact tools for server, local and remote CLI", () => {
    const matrix = Object.fromEntries(
      operations.map((operation) => [
        operation,
        Object.fromEntries(profiles.map((profile) => [profile, profileAvailability(profile, operation)])),
      ]),
    );
    const offline = { server: "server", local: "offline", "remote-cli": "remote" };
    expect(matrix).toEqual({
      verify_supported_media_types: offline,
      verify_capture_file: offline,
      verify_capture_source: { server: "server", local: "capture provider", "remote-cli": "remote" },
      verify_list_captures: offline,
      verify_read_capture: offline,
      verify_search_capture: offline,
      verify_locate_quote: offline,
      verify_register_artifact: offline,
      verify_get_artifact: offline,
    });
  });

  it("keeps database-backed and platform operations server-only on the local profile", () => {
    for (const operation of serverBacked) {
      expect(profileAvailability("local", operation), operation).toBe("server only");
      expect(profileAvailability("server", operation), operation).toBe("server");
      expect(profileAvailability("remote-cli", operation), operation).toBe("remote");
    }
  });
});
