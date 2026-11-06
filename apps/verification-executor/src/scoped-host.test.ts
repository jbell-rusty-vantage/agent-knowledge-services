import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createScopedCustodyHost, ScopedExecutorAccess } from "./scoped-host.js";

describe("public scoped host", () => {
  it("installs a grant after the actual parent exists and keeps its authority immutable", async () => {
    const host = new ScopedExecutorAccess({ grants: [] });
    const assignment = {
      tenantId: randomUUID(),
      callerId: "host",
      runId: "run",
      parentSessionId: "actual-parent",
      assignmentId: "child",
      producerAttemptId: randomUUID(),
      role: "synthesizer",
      pinSha256: "a".repeat(64),
      grantId: "grant",
      readScope: [],
      allowedOperations: ["read"],
      namespace: "",
      deadline: "2030-01-01T00:00:00Z",
    };
    assignment.namespace = `${assignment.tenantId}/run/child`;
    await expect(host.authorizeGrant(assignment)).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
    const installation = {
      assignment,
      operations: [{ name: "read", input: z.strictObject({}), execute: async () => "retained" }],
    };
    host.installGrant(installation);
    expect(await host.executeScoped({ assignment, operation: "read", payload: {} })).toBe("retained");
    expect(() => host.installGrant(installation)).toThrow("SCOPED_GRANT_DUPLICATE");
    await expect(host.authorizeGrant({ ...assignment, parentSessionId: "other-parent" })).rejects.toThrow(
      "SCOPED_GRANT_UNAUTHORIZED",
    );
    host.revoke(assignment.grantId);
    expect(() => host.installGrant(installation)).toThrow("SCOPED_GRANT_DUPLICATE");
    await expect(host.authorizeGrant(assignment)).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
  });

  it("refuses local-only custody before starting the host", async () => {
    await expect(createScopedCustodyHost({ env: {} })).rejects.toThrow("SCOPED_HOST_REMOTE_CUSTODY_REQUIRED");
  });

  it("rejects conflicting producer configuration before opening a database or writing a store", async () => {
    await expect(
      createScopedCustodyHost({
        env: {
          KNOWLEDGE_DB_URL: "postgres://unused",
          KNOWLEDGE_ARTIFACT_STORAGE: "supabase",
          SUPABASE_URL: "http://unused",
          SUPABASE_SERVICE_ROLE_KEY: "unused",
          VERIFY_TENANT_ID: randomUUID(),
          KNOWLEDGE_TENANT_ID: randomUUID(),
          VERIFY_PRODUCER_ATTEMPT_ID: randomUUID(),
          VERIFY_VERIFIER_ATTEMPT_ID: randomUUID(),
          KNOWLEDGE_PRODUCER_ATTEMPT_ID: randomUUID(),
        },
      }),
    ).rejects.toThrow("SCOPED_HOST_PRODUCER_BINDING");
  });
});
