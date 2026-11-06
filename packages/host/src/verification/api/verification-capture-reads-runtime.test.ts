import { describe, expect, it, vi } from "vitest";

import { createVerificationCaptureReads } from "./verification-capture-reads-runtime.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const tenantId = id(1),
  operationId = id(2),
  missionId = id(3);
const grantedActor = {
  kind: "service" as const,
  id: id(4),
  serviceIdentity: "mission_control_client" as const,
};
const otherActor = {
  kind: "service" as const,
  id: id(5),
  serviceIdentity: "mission_control_client" as const,
};
const environment = {
  VERIFICATION_CAPTURE_READS_ENABLED: "1",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SECRET_KEY: "unit-test-service-role-key",
  VERIFICATION_PARSER_IMAGE_DIGEST: digest,
  VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON: JSON.stringify([
    {
      tenantId,
      actor: grantedActor,
      missionId,
      agentDeploymentId: "capture-worker",
      capabilityVersion: "verification-service.v1",
    },
  ]),
};

describe("capture-read native runtime authority", () => {
  it("stays disabled or fails closed on invalid/incomplete server configuration", () => {
    expect(createVerificationCaptureReads(undefined, {})).toBeUndefined();
    expect(() =>
      createVerificationCaptureReads(undefined, {
        VERIFICATION_CAPTURE_READS_ENABLED: "maybe",
      }),
    ).toThrow("INVALID_VERIFICATION_CAPTURE_READS_ENABLED");
    expect(() => createVerificationCaptureReads(undefined, { ...environment })).toThrow(
      "VERIFICATION_CAPTURE_READS_CONFIGURATION_REQUIRED",
    );
  });

  it("rejects a non-granted actor before any database or CAS custody read", async () => {
    const transaction = vi.fn(async () => {
      throw new Error("database must not be called");
    });
    const reads = createVerificationCaptureReads({ transaction } as never, environment);
    await expect(reads!.getCapture({ tenantId, operationId, actor: otherActor })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns generic not-found for a granted actor whose capture operation is absent before CAS access", async () => {
    const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({
      rows: [],
    }));
    const transaction = vi.fn(async (_tenant: string, work: (client: { query: typeof query }) => Promise<unknown>) =>
      work({ query }),
    );
    const reads = createVerificationCaptureReads({ transaction } as never, environment);
    await expect(reads!.getCapture({ tenantId, operationId, actor: grantedActor })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("knowledge_service.operation");
  });
});
