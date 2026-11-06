import { describe, expect, it, vi } from "vitest";
import { CanonicalActivityError } from "./activity-registry.js";
import { verificationActivityHandlers } from "./verification-activities.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: "verification",
  actor: { kind: "service" as const, id: id(4), serviceIdentity: "knowledge_worker" as const },
  capabilityVersion: "verification-service.v1",
  idempotencyKey: "verification-worker-001",
  reason: "test",
  contractVersion: "v1" as const,
};
const invocation = (
  kind: "verification_capture" | "verification_extraction" | "verification_replay",
  step: string,
) => ({
  operation: {} as never,
  claim: {} as never,
  activity: {
    schemaVersion: "knowledge-operation-request/v1" as const,
    kind,
    operationInput: { schemaVersion: "verification-service-request.v1" },
    expectedVersions: { verification: "verification.v1" },
    context,
    step: { name: step, ordinal: 0 },
  },
});

describe("verification durable worker handlers", () => {
  it("registers only the three complete kind and step pairs and shares one executor", async () => {
    const execute = vi.fn(async (kind) => ({ kind, registered: true })),
      handlers = verificationActivityHandlers({ execute } as never);
    expect(handlers.map((item) => `${item.operationKind}:${item.stepName}`)).toEqual([
      "verification_capture:register_and_admit",
      "verification_extraction:verify_and_register",
      "verification_replay:hydrate_and_recompute",
    ]);
    await expect(handlers[1]!.execute(invocation("verification_extraction", "verify_and_register"))).resolves.toEqual({
      kind: "verification_extraction",
      registered: true,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("makes deterministic failures nonretryable and scrubs unknown infrastructure messages", async () => {
    const deterministic = verificationActivityHandlers({
      execute: async () => {
        throw new Error("VERIFICATION_CAPTURE_GRANT_REQUIRED");
      },
    } as never)[0]!;
    await expect(deterministic.execute(invocation("verification_capture", "register_and_admit"))).rejects.toMatchObject(
      { code: "VERIFICATION_CAPTURE_GRANT_REQUIRED", retryable: false, message: "VERIFICATION_CAPTURE_GRANT_REQUIRED" },
    );
    const infrastructure = verificationActivityHandlers({
      execute: async () => {
        throw new Error("password=secret host=db.example");
      },
    } as never)[0]!;
    const failure = (await Promise.resolve(
      infrastructure.execute(invocation("verification_capture", "register_and_admit")),
    ).catch((error: unknown) => error)) as CanonicalActivityError;
    expect(failure).toBeInstanceOf(CanonicalActivityError);
    expect(failure).toMatchObject({
      code: "VERIFICATION_INFRASTRUCTURE_FAILURE",
      retryable: true,
      message: "VERIFICATION_INFRASTRUCTURE_FAILURE",
    });
    expect(String(failure)).not.toContain("secret");
  });
});
