import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SandboxedVerificationParser } from "./verification-parser.js";

describe("verification parser pre-execution admission", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  it("rejects mutable image names before a process can be started", () => {
    expect(() => new SandboxedVerificationParser("parser:latest" as never)).toThrow("PARSER_IMAGE_DIGEST_REQUIRED");
  });
  it("rejects mismatched input identity without requiring Docker", async () => {
    const parser = new SandboxedVerificationParser(digest, "nonexistent-docker-do-not-execute");
    await expect(parser.parse({ kind: "pdf", bytes: new Uint8Array([1]), parentDigest: digest })).rejects.toThrow(
      "PARSER_PARENT_DIGEST_MISMATCH",
    );
  });
  it("rejects oversized and empty inputs before copying or starting a process", async () => {
    const parser = new SandboxedVerificationParser(digest, "nonexistent-docker-do-not-execute");
    for (const bytes of [new Uint8Array(), new Uint8Array(8_000_001)])
      await expect(parser.parse({ kind: "pdf", bytes, parentDigest: digest })).rejects.toThrow(
        "PARSER_INPUT_LIMIT_OR_TYPE",
      );
  });
  it("preserves a pre-create runtime error when there is no container to clean up", async () => {
    const bytes = new Uint8Array([1]);
    const parentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const parser = new SandboxedVerificationParser(digest, "nonexistent-docker-do-not-execute");
    await expect(parser.parse({ kind: "pdf", bytes, parentDigest })).rejects.toThrow("PARSER_RUNTIME_UNAVAILABLE");
  });
});
