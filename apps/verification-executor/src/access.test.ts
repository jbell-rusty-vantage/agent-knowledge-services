import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ScopedExecutorAccess, scopedCustodyOperations } from "./access.js";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ks-scoped-access-"));
  directories.push(directory);
  const tenantId = randomUUID();
  const producerAttemptId = randomUUID();
  const executor = await VerificationExecutor.create(
    loadExecutorConfig({
      VERIFY_STORE_DIR: directory,
      VERIFY_TENANT_ID: tenantId,
      VERIFY_PRODUCER_ATTEMPT_ID: producerAttemptId,
      VERIFY_VERIFIER_ATTEMPT_ID: randomUUID(),
      VERIFY_GIT_SHA: "test",
    }),
  );
  const source = await executor.registerArtifact({
    bytes: new TextEncoder().encode("source context"),
    mediaType: "text/plain",
  });
  const assignment = {
    tenantId,
    callerId: "host",
    runId: randomUUID(),
    parentSessionId: "parent",
    assignmentId: "child",
    producerAttemptId,
    role: "report-synthesizer",
    pinSha256: "a".repeat(64),
    grantId: "grant",
    readScope: [source.artifactId],
    allowedOperations: ["verify_get_artifact", "verify_register_artifact"],
    namespace: "",
    deadline: "2030-01-01T00:00:00Z",
    reservation: { toolCalls: 10 },
  };
  assignment.namespace = `${tenantId}/${assignment.runId}/${assignment.assignmentId}`;
  const operations = scopedCustodyOperations(executor);
  const access = new ScopedExecutorAccess({ grants: [{ assignment, operations }] });
  const invoke = (operation: string, payload: unknown) => access.executeScoped({ assignment, operation, payload });
  return { executor, source, assignment, operations, access, invoke };
}

describe("host-owned child grants", () => {
  it("reads only assigned artifacts and bounds the returned content", async () => {
    const f = await fixture();
    expect(await f.invoke("verify_get_artifact", { artifactId: f.source.artifactId, length: 6 })).toMatchObject({
      text: "source",
      hasMore: true,
    });
    const foreign = await f.executor.registerArtifact({
      bytes: new TextEncoder().encode("foreign"),
      mediaType: "text/plain",
    });
    await expect(f.invoke("verify_get_artifact", { artifactId: foreign.artifactId })).rejects.toThrow(
      "SCOPED_RESOURCE_FORBIDDEN",
    );
    await expect(f.invoke("verify_get_artifact", { digest: f.source.digest })).rejects.toThrow();
  });

  it("binds artifact writes to the assigned run and namespace and retains only their handles", async () => {
    const f = await fixture();
    const result = (await f.invoke("verify_register_artifact", {
      name: "report",
      text: "A report.",
      mediaType: "text/markdown",
    })) as { artifactId: string };
    expect(result).toMatchObject({
      namespace: f.assignment.namespace,
      producerAttemptId: f.assignment.producerAttemptId,
    });
    expect(await f.executor.store.resolveHandle({ artifactId: result.artifactId })).toMatchObject({
      dataClassification: "internal",
    });
    expect(await f.invoke("verify_get_artifact", { artifactId: result.artifactId })).toMatchObject({
      text: "A report.",
    });
    const steps = await f.executor.store.listSteps(f.assignment.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.input).toMatchObject({ label: `${f.assignment.namespace}/report` });
    const other = {
      ...f.assignment,
      assignmentId: "other",
      grantId: "other",
      namespace: `${f.assignment.tenantId}/${f.assignment.runId}/other`,
    };
    const access = new ScopedExecutorAccess({ grants: [{ assignment: other, operations: f.operations }] });
    await expect(
      access.executeScoped({
        assignment: other,
        operation: "verify_get_artifact",
        payload: { artifactId: result.artifactId },
      }),
    ).rejects.toThrow("SCOPED_RESOURCE_FORBIDDEN");
  });

  it.each([
    "tenantId",
    "callerId",
    "runId",
    "parentSessionId",
    "assignmentId",
    "producerAttemptId",
    "role",
    "pinSha256",
    "grantId",
    "namespace",
    "deadline",
    "reservation",
  ])("rejects changed assignment %s before execution", async (key) => {
    const f = await fixture();
    const changed = {
      ...f.assignment,
      [key]:
        key === "reservation"
          ? { toolCalls: 11 }
          : key === "pinSha256"
            ? "b".repeat(64)
            : key === "deadline"
              ? "2031-01-01T00:00:00Z"
              : "changed",
    };
    await expect(
      f.access.executeScoped({
        assignment: changed,
        operation: "verify_register_artifact",
        payload: { text: "x", mediaType: "text/plain", name: "x" },
      }),
    ).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
    expect(await f.executor.store.listSteps(f.assignment.runId)).toEqual([]);
  });

  it.each(["tenantId", "runId", "producerAttemptId", "namespace", "label"])(
    "rejects payload scope override %s without a write",
    async (key) => {
      const f = await fixture();
      await expect(
        f.invoke("verify_register_artifact", { text: "x", mediaType: "text/plain", name: "x", [key]: "foreign" }),
      ).rejects.toThrow();
      expect(await f.executor.store.listSteps(f.assignment.runId)).toEqual([]);
    },
  );

  it("rejects missing installed operations at construction and unassigned ones at invocation", async () => {
    const f = await fixture();
    expect(
      () =>
        new ScopedExecutorAccess({
          grants: [{ assignment: { ...f.assignment, allowedOperations: ["db_sql"] }, operations: f.operations }],
        }),
    ).toThrow("SCOPED_OPERATION_NOT_INSTALLED");
    await expect(f.invoke("verify_read_capture", { captureId: "capture" })).rejects.toThrow(
      "SCOPED_OPERATION_FORBIDDEN",
    );
    const catalog = f.access.catalog(f.assignment);
    expect(catalog.operations.map((item) => item.name)).toEqual(["verify_get_artifact", "verify_register_artifact"]);
    expect(catalog.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.operations[1]?.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it("rejects expired and revoked grants and does not retain caller-owned mutable scope", async () => {
    const f = await fixture();
    const expired = new ScopedExecutorAccess({
      grants: [{ assignment: f.assignment, operations: f.operations }],
      now: () => Date.parse(f.assignment.deadline),
    });
    await expect(expired.authorizeGrant(f.assignment)).rejects.toThrow("SCOPED_GRANT_EXPIRED");
    f.assignment.readScope.push("foreign");
    await expect(f.access.authorizeGrant(f.assignment)).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
    f.assignment.readScope.pop();
    f.access.revoke(f.assignment.grantId);
    await expect(f.access.authorizeGrant(f.assignment)).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
  });

  it("rejects an executor belonging to a different producer attempt", async () => {
    const f = await fixture();
    const assignment = { ...f.assignment, producerAttemptId: randomUUID() };
    const access = new ScopedExecutorAccess({ grants: [{ assignment, operations: f.operations }] });
    await expect(
      access.executeScoped({
        assignment,
        operation: "verify_register_artifact",
        payload: { name: "x", text: "x", mediaType: "text/plain" },
      }),
    ).rejects.toThrow("SCOPED_EXECUTOR_BINDING");
    expect(await f.executor.store.listSteps(f.assignment.runId)).toEqual([]);
  });

  it("restores host-verified artifact access without expanding the immutable assignment", async () => {
    const f = await fixture();
    const result = (await f.invoke("verify_register_artifact", {
      name: "handoff",
      text: "Retained output.",
      mediaType: "text/plain",
    })) as { artifactId: string };
    const access = new ScopedExecutorAccess({
      grants: [{ assignment: f.assignment, operations: f.operations, restoredArtifactIds: [result.artifactId] }],
    });
    const request = {
      assignment: f.assignment,
      operation: "verify_get_artifact",
      payload: { artifactId: result.artifactId },
    };
    expect(await access.executeScoped(request)).toMatchObject({ text: "Retained output." });
    expect(f.assignment.readScope).toEqual([f.source.artifactId]);
    const emptyRestore = new ScopedExecutorAccess({ grants: [{ assignment: f.assignment, operations: f.operations }] });
    await expect(emptyRestore.executeScoped(request)).rejects.toThrow("SCOPED_RESOURCE_FORBIDDEN");
    await expect(
      emptyRestore.executeScoped({
        ...request,
        assignment: { ...f.assignment, restoredArtifactIds: [result.artifactId] },
      }),
    ).rejects.toThrow("SCOPED_GRANT_UNAUTHORIZED");
  });
});
