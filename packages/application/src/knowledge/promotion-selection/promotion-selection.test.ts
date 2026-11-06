import { describe, expect, it } from "vitest";
import { PromotionSelectionSchema } from "@aiengineer/knowledge-contracts";
import {
  PromotionSelectionApplication,
  type PromotionSelectionApplicationPorts,
  type PromotionSelectionOperation,
} from "./promotion-selection.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  const selection = PromotionSelectionSchema.parse({
    schemaVersion: "promotion-selection.v1",
    tenantId: id(1),
    expectedKnowledgeHead: 1,
    runPinDigest: digest,
    policyDigest: digest,
    selected: [
      {
        memberId: "selected",
        content: { kind: "chunk", id: id(2), digest },
        target: { kind: "chunk", canonicalId: id(2), projectionTargetId: id(3) },
        targetSpaces: ["source_native_sections"],
        sourceChunks: [
          {
            chunkId: id(2),
            chunkDigest: digest,
            representationId: id(4),
            representationDigest: digest,
            representationClass: "source_native",
            captureId: id(5),
            sourceFamilyId: "primary",
          },
        ],
        admittedClaims: [],
        contentLinkReceiptIds: [id(6)],
        reason: "Selected",
        estimatedBytes: 1,
        estimatedTokens: 1,
        estimatedCostMicros: 0,
      },
    ],
    excluded: [],
    budget: { maxMembers: 1, maxBytes: 100, maxTokens: 100, maxCostMicros: 10, deadline: "2099-01-01T00:00:00Z" },
    proposedBy: "producer",
    requiredReviewer: "reviewer",
  });
  const stored = new Map<string, PromotionSelectionOperation>(),
    submitted: string[] = [];
  let review: "approve" | "reject" | "pending" = "pending",
    lostAck = false;
  const ports: PromotionSelectionApplicationPorts = {
    async authenticate() {
      return { selectionDigest: digest };
    },
    async findOperation({ idempotencyKey }) {
      return stored.get(idempotencyKey);
    },
    async submitOperation(input) {
      submitted.push(input.stage);
      const operation: PromotionSelectionOperation = {
        operationId: id(submitted.length + 10),
        idempotencyKey: input.idempotencyKey,
        selectionDigest: digest,
        stage: input.stage,
        ...(input.targetSpace ? { targetSpace: input.targetSpace } : {}),
        status: "succeeded",
        receiptId: id(submitted.length + 20),
      };
      stored.set(input.idempotencyKey, operation);
      if (lostAck) {
        lostAck = false;
        throw new Error("lost acknowledgement");
      }
      return operation;
    },
    async readReview({ prepared }) {
      return {
        decision: review,
        selectionDigest: digest,
        prepareOperationId: prepared.operationId,
        reviewerIdentity: "reviewer",
      };
    },
  };
  return {
    selection,
    ports,
    stored,
    submitted,
    app: new PromotionSelectionApplication(ports),
    artifact: { id: id(7), digest },
    approve() {
      review = "approve";
    },
    reject() {
      review = "reject";
    },
    loseAck() {
      lostAck = true;
    },
  };
}
describe("promotion selection canonical stage composition", () => {
  function multiSpaceFixture() {
    const f = fixture(),
      member = f.selection.selected[0]!;
    member.content = { kind: "claim", id: id(2), digest };
    member.target = { kind: "claim", canonicalId: id(2), projectionTargetId: id(3) };
    member.targetSpaces = ["model_capabilities", "engineering_claims"];
    member.admittedClaims = [{ runId: "run", claimId: "claim", claimDigest: digest, admissionDigest: digest }];
    f.approve();
    return f;
  }
  it("submits one embedding per selected space and gives index every original receipt", async () => {
    const f = multiSpaceFixture(),
      submit = f.ports.submitOperation;
    let indexed: readonly PromotionSelectionOperation[] = [];
    f.ports.submitOperation = async (input) => {
      if (input.stage === "index") indexed = input.predecessors;
      return submit(input);
    };
    const result = await f.app.advance(f);
    expect(result.status).toBe("complete");
    expect(f.submitted).toEqual(["prepare", "embed", "embed", "index"]);
    expect(indexed.map((operation) => [operation.stage, operation.targetSpace])).toEqual([
      ["prepare", undefined],
      ["embed", "engineering_claims"],
      ["embed", "model_capabilities"],
    ]);
    expect(new Set(indexed.map((operation) => operation.idempotencyKey)).size).toBe(3);
    await f.app.advance(f);
    expect(f.submitted).toHaveLength(4);
  });
  it("keeps index pending until every space has a succeeded embedding receipt", async () => {
    const f = multiSpaceFixture(),
      submit = f.ports.submitOperation;
    f.ports.submitOperation = async (input) => {
      const result = await submit(input);
      if (input.targetSpace !== "model_capabilities") return result;
      const running = { ...result, status: "running" as const, receiptId: null };
      f.stored.set(input.idempotencyKey, running);
      return running;
    };
    expect((await f.app.advance(f)).status).toBe("waiting");
    expect(f.submitted).toEqual(["prepare", "embed", "embed"]);
    expect((await f.app.advance(f)).status).toBe("waiting");
    expect(f.submitted).toHaveLength(3);
  });
  it("recovers a lost second-space acknowledgement without resubmitting either embedding", async () => {
    const f = multiSpaceFixture(),
      submit = f.ports.submitOperation;
    let lost = false;
    f.ports.submitOperation = async (input) => {
      const result = await submit(input);
      if (input.targetSpace === "model_capabilities" && !lost) {
        lost = true;
        throw new Error("second-space lost acknowledgement");
      }
      return result;
    };
    await expect(f.app.advance(f)).rejects.toThrow("second-space lost acknowledgement");
    expect((await f.app.advance(f)).status).toBe("complete");
    expect(f.submitted).toEqual(["prepare", "embed", "embed", "index"]);
  });
  it("refuses a retained embedding receipt labelled for another space", async () => {
    const f = multiSpaceFixture(),
      submit = f.ports.submitOperation;
    f.ports.submitOperation = async (input) => {
      const result = await submit(input);
      return input.stage === "embed" ? { ...result, targetSpace: "source_native_sections" } : result;
    };
    await expect(f.app.advance(f)).rejects.toThrow("OPERATION_BINDING_MISMATCH");
    expect(f.submitted).toEqual(["prepare", "embed"]);
  });
  it("rechecks review before index even after all embeddings have completed", async () => {
    const f = multiSpaceFixture(),
      readReview = f.ports.readReview;
    let calls = 0;
    f.ports.readReview = async (input) => {
      const result = await readReview(input);
      return ++calls === 3 ? { ...result, decision: "reject" } : result;
    };
    expect((await f.app.advance(f)).status).toBe("blocked");
    expect(f.submitted).toEqual(["prepare", "embed", "embed"]);
  });
  it("waits for independent review then composes the existing stages in order", async () => {
    const f = fixture();
    expect((await f.app.advance(f)).status).toBe("review_required");
    expect(f.submitted).toEqual(["prepare"]);
    f.approve();
    expect((await f.app.advance(f)).status).toBe("complete");
    expect(f.submitted).toEqual(["prepare", "embed", "index"]);
    await f.app.advance(f);
    expect(f.submitted).toHaveLength(3);
  });
  it("reconciles a lost acknowledgement by original canonical idempotency key", async () => {
    const f = fixture();
    f.loseAck();
    await expect(f.app.advance(f)).rejects.toThrow("lost acknowledgement");
    expect((await f.app.advance(f)).status).toBe("review_required");
    expect(f.submitted).toEqual(["prepare"]);
  });
  it("never embeds after a rejected review", async () => {
    const f = fixture();
    f.reject();
    expect((await f.app.advance(f)).status).toBe("blocked");
    expect(f.submitted).toEqual(["prepare"]);
  });
  it("requires retained receipts even for a succeeded operation", async () => {
    const f = fixture();
    f.ports.findOperation = async ({ idempotencyKey }) => ({
      operationId: id(9),
      idempotencyKey,
      selectionDigest: digest,
      stage: "prepare",
      status: "succeeded",
      receiptId: null,
    });
    expect((await f.app.advance(f)).status).toBe("waiting");
    expect(f.submitted).toEqual([]);
  });
  it("rejects forged selection, operation and reviewer bindings", async () => {
    const a = fixture();
    a.ports.authenticate = async () => ({ selectionDigest: "different" });
    await expect(a.app.advance(a)).rejects.toThrow("AUTHENTICATION_MISMATCH");
    expect(a.submitted).toEqual([]);
    const b = fixture();
    b.ports.findOperation = async ({ idempotencyKey }) => ({
      operationId: id(9),
      idempotencyKey,
      selectionDigest: "different",
      stage: "prepare",
      status: "succeeded",
      receiptId: id(8),
    });
    await expect(b.app.advance(b)).rejects.toThrow("OPERATION_BINDING_MISMATCH");
    const c = fixture();
    c.ports.readReview = async ({ prepared }) => ({
      decision: "approve",
      selectionDigest: digest,
      prepareOperationId: prepared.operationId,
      reviewerIdentity: "producer",
    });
    await expect(c.app.advance(c)).rejects.toThrow("REVIEW_BINDING_MISMATCH");
    expect(c.submitted).toEqual(["prepare"]);
  });
});
