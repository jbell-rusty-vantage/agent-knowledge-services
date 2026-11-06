import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createKnowledgeResourceReads } from "@aiengineer/knowledge-application";
import { KnowledgeClient } from "@aiengineer/knowledge-client";
import type { OperationContext } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, resolveCommand } from "../../../cli/src/commands.js";
import { createMcpToolExecutor } from "../index.js";

function replayFixture() {
  const packetId = randomUUID();
  const context: OperationContext = {
    tenantId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    correlationId: "citation-read",
    actor: { kind: "human", id: randomUUID() },
    capabilityVersion: "v1",
    idempotencyKey: "citation-read",
    reason: "Replay retained citations",
    contractVersion: "v1",
  };
  const replay = {
    schemaVersion: "knowledge.retrieval-citation-replay/v1" as const,
    evidencePacketId: packetId,
    retrievalRunId: randomUUID(),
    packetDigest: `sha256:${"a".repeat(64)}`,
    citations: [],
    failures: [],
    replayedAt: "2026-09-16T00:00:00.000Z",
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toBe(`https://knowledge.example/v1/evidence-packets/${packetId}/citations`);
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer consumer-token");
    expect(headers.get("x-tenant-id")).toBe(context.tenantId);
    return new Response(JSON.stringify(replay), {
      headers: { "content-type": "application/json" },
    });
  });
  const client = new KnowledgeClient({
    baseUrl: "https://knowledge.example",
    getAccessToken: () => "consumer-token",
    fetch,
  });
  const submit = vi.fn();
  // MCP replays in process through the same custody port the API route uses.
  const replayEvidencePacketCitations = vi.fn(async (tenantId: string, id: string) => {
    expect(tenantId).toBe(context.tenantId);
    expect(id).toBe(packetId);
    return replay;
  });
  const identity = {
    actor: context.actor,
    grants: [
      {
        tenantId: context.tenantId,
        roles: ["knowledge_reader" as const],
        scopes: [],
      },
    ],
  };
  const executor = createMcpToolExecutor({
    apiOrigin: "https://knowledge.example",
    identity,
    knowledge: {
      reads: createKnowledgeResourceReads({ replayEvidencePacketCitations }),
    },
    operationService: { submit } as never,
  });
  return {
    packetId,
    context,
    replay,
    fetch,
    client,
    submit,
    executor,
    replayEvidencePacketCitations,
  };
}

describe("public retrieval citation adapters", () => {
  it("CLI dispatch replays through the authenticated public client without a write", async () => {
    const fixture = replayFixture();
    await expect(
      dispatchCliCommand(
        fixture.client,
        resolveCommand("retrieve", "citations")!,
        { packetId: fixture.packetId },
        fixture.context,
      ),
    ).resolves.toEqual(fixture.replay);
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("MCP permits a reader to replay without submitting an evidence-packet operation", async () => {
    const fixture = replayFixture();
    const result = await fixture.executor("knowledge_retrieve_citations", "evidence_packet", {
      context: fixture.context,
      input: { packetId: fixture.packetId },
      expectedVersions: { api: "v1" },
    });
    expect(result).toMatchObject({ structuredContent: fixture.replay });
    expect(fixture.replayEvidencePacketCitations).toHaveBeenCalledOnce();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("rejects tenant/actor forgery and caller-supplied replay authority before transport", async () => {
    const fixture = replayFixture();
    for (const context of [
      { ...fixture.context, tenantId: randomUUID() },
      {
        ...fixture.context,
        actor: { ...fixture.context.actor, id: randomUUID() },
      },
    ]) {
      expect(
        await fixture.executor("knowledge_retrieve_citations", "evidence_packet", {
          context,
          input: { packetId: fixture.packetId },
          expectedVersions: { api: "v1" },
        }),
      ).toMatchObject({ isError: true });
    }
    const input = {
      packetId: fixture.packetId,
      storageKey: "caller-controlled",
    };
    expect(
      await fixture.executor("knowledge_retrieve_citations", "evidence_packet", {
        context: fixture.context,
        input,
        expectedVersions: { api: "v1" },
      }),
    ).toMatchObject({ isError: true });
    await expect(
      dispatchCliCommand(fixture.client, resolveCommand("retrieve", "citations")!, input, fixture.context),
    ).rejects.toThrow("RETRIEVAL_PACKET_READ_INPUT_INVALID");
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.replayEvidencePacketCitations).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it("fails closed when in-process citation replay is not composed", async () => {
    const fixture = replayFixture();
    const execute = createMcpToolExecutor({
      apiOrigin: "https://knowledge.example",
      identity: {
        actor: fixture.context.actor,
        grants: [
          {
            tenantId: fixture.context.tenantId,
            roles: ["knowledge_reader"],
            scopes: [],
          },
        ],
      },
      operationService: { submit: fixture.submit } as never,
    });
    expect(
      await execute("knowledge_retrieve_citations", "evidence_packet", {
        context: fixture.context,
        input: { packetId: fixture.packetId },
        expectedVersions: { api: "v1" },
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: JSON.stringify({ code: "CAPABILITY_NOT_ADMITTED" }) }],
    });
    // Composed reads without citation custody are equally not admitted; never an HTTP fallback.
    const withoutCustody = createMcpToolExecutor({
      apiOrigin: "https://knowledge.example",
      identity: {
        actor: fixture.context.actor,
        grants: [
          {
            tenantId: fixture.context.tenantId,
            roles: ["knowledge_reader"],
            scopes: [],
          },
        ],
      },
      knowledge: { reads: createKnowledgeResourceReads({}) },
      operationService: { submit: fixture.submit } as never,
    });
    expect(
      await withoutCustody("knowledge_retrieve_citations", "evidence_packet", {
        context: fixture.context,
        input: { packetId: fixture.packetId },
        expectedVersions: { api: "v1" },
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: JSON.stringify({ code: "CAPABILITY_NOT_ADMITTED" }) }],
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });
});
