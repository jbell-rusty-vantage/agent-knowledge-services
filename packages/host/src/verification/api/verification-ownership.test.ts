import { describe, expect, it, vi } from "vitest";
import { createVerificationOwnershipResolver } from "./verification-ownership.js";
import type { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = {
  kind: "service" as const,
  id: id(1),
  serviceIdentity: "mission_control_client" as const,
};
const grant = {
  tenantId: id(2),
  actor,
  missionId: id(3),
  agentDeploymentId: "worker.v1",
  capabilityVersion: "verification-service.v1",
};

describe("verification ownership grant admission", () => {
  it("rejects ambiguous or caller-extended server configuration", () => {
    const database = {} as PostgresCanonicalRepository;
    expect(() => createVerificationOwnershipResolver(database, JSON.stringify([grant, grant]))).toThrow(
      "DUPLICATE_VERIFICATION_OWNERSHIP_GRANT",
    );
    expect(() =>
      createVerificationOwnershipResolver(database, JSON.stringify([{ ...grant, allowAnyAttempt: true }])),
    ).toThrow();
    expect(() => createVerificationOwnershipResolver(database, "[]")).toThrow();
  });

  it("refuses the retired Eve runtime authority grant (SV-17)", () => {
    const database = {} as PostgresCanonicalRepository;
    expect(() =>
      createVerificationOwnershipResolver(
        database,
        JSON.stringify([
          { ...grant, eveRuntimeAuthority: { grantId: "eve-grant", issuer: "eve.host", keyIds: ["k1"] } },
        ]),
      ),
    ).toThrow();
  });

  it("denies missing routing IDs and ungranted identities before database access", async () => {
    const transaction = vi.fn(),
      resolver = createVerificationOwnershipResolver(
        { transaction } as unknown as PostgresCanonicalRepository,
        JSON.stringify([grant]),
      );
    const input = {
      tenantId: grant.tenantId,
      identity: { actor },
      correlationId: "correlation",
      idempotencyKey: "ownership-001",
      useCase: "verifyExtraction",
      hints: {},
    };
    expect(await resolver(input)).toBeUndefined();
    expect(
      await resolver({
        ...input,
        identity: { actor: { ...actor, id: id(9) } },
        hints: {
          attemptId: id(4),
          workItemId: id(5),
          missionId: grant.missionId,
        },
      }),
    ).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("binds an owned attempt to the server grant and refuses a caller-supplied external execution", async () => {
    const transaction = vi.fn(
      async (_tenant: string, callback: (client: { query: ReturnType<typeof vi.fn> }) => unknown) =>
        callback({ query: vi.fn(async () => ({ rows: [{ id: id(5) }] })) }),
    );
    const resolver = createVerificationOwnershipResolver(
      { transaction } as unknown as PostgresCanonicalRepository,
      JSON.stringify([grant]),
    );
    const input = {
      tenantId: grant.tenantId,
      identity: { actor },
      correlationId: "correlation",
      idempotencyKey: "ownership-002",
      useCase: "verifyExtraction",
      hints: { attemptId: id(5), workItemId: id(4), missionId: grant.missionId },
    };
    const context = await resolver(input);
    expect(context).toMatchObject({
      tenantId: grant.tenantId,
      attemptId: id(5),
      missionId: grant.missionId,
      capabilityVersion: grant.capabilityVersion,
    });
    expect(context?.externalExecution).toBeUndefined();
    expect(
      await resolver({
        ...input,
        hints: { ...input.hints, externalExecution: { runtime: "eve", runId: "forged" } },
      }),
    ).toBeUndefined();
  });
});
