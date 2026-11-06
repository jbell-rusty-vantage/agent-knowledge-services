import { describe, expect, it } from "vitest";
import { FORBIDDEN_MCP_CAPABILITIES, MCP_TOOL_CATALOG, VERIFICATION_MCP_TOOL_NAMES } from "../catalog.js";
describe("bounded MCP catalog", () => {
  it("matches the admitted Gate 6 catalog and excludes authority bypasses", () => {
    expect(Object.keys(MCP_TOOL_CATALOG)).toHaveLength(40);
    expect(Object.keys(MCP_TOOL_CATALOG)).toContain("knowledge_retrieve_build_packet");
    expect(Object.keys(MCP_TOOL_CATALOG)).not.toContain("publication.publish");
    for (const forbidden of FORBIDDEN_MCP_CAPABILITIES) expect(Object.keys(MCP_TOOL_CATALOG)).not.toContain(forbidden);
  });
  it("lists only complete bounded verification tools", () => {
    expect(VERIFICATION_MCP_TOOL_NAMES).toEqual([
      "verify_extraction_run",
      "verify_benchmark_capture",
      "verify_artifact_parse",
      "verify_extract",
      "verify_bundle_replay",
      "verify_benchmark_run",
      "verify_benchmark_compare",
    ]);
  });
});
