import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_MCP_CAPABILITIES,
  MCP_TOOL_CATALOG,
  SYSTEM_MCP_TOOL_NAMES,
  VERIFICATION_MCP_TOOL_NAMES,
} from "../catalog.js";
describe("bounded MCP catalog", () => {
  it("matches the admitted Gate 6 catalog and excludes authority bypasses", () => {
    // 2026-11-15: the three knowledge_promotion_propose_* names and knowledge_embed_status were other names for
    // knowledge_promotion_propose and knowledge_promotion_status and are gone; knowledge_operation_result is new.
    expect(Object.keys(MCP_TOOL_CATALOG)).toHaveLength(29);
    for (const removed of [
      "knowledge_promotion_propose_domain_mapping",
      "knowledge_promotion_propose_claims",
      "knowledge_promotion_propose_entity_links",
      "knowledge_embed_status",
    ])
      expect(Object.keys(MCP_TOOL_CATALOG)).not.toContain(removed);
    expect(Object.keys(MCP_TOOL_CATALOG)).toContain("knowledge_operation_result");
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
  it("names the tool an agent starts from and the tool that explains the others", () => {
    expect(SYSTEM_MCP_TOOL_NAMES).toEqual(["knowledge_guide", "knowledge_describe"]);
    for (const name of SYSTEM_MCP_TOOL_NAMES) expect(Object.keys(MCP_TOOL_CATALOG)).not.toContain(name);
  });
});
