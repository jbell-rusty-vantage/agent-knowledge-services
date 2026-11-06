import { expect, it, vi } from "vitest";
import type { TenantSqlClient } from "./postgres.js";
import { assertSignedReportSourceDependencies } from "./report-source-dependencies.js";

vi.mock("./content-representation-admission.js", () => ({
  readContentRepresentationAdmission: vi.fn(async () => ({ accepted: false })),
}));

const artifactId = "00000000-0000-4000-8000-000000000001",
  digest = `sha256:${"a".repeat(64)}`;
function fixture(representation: string | null, authorized = true) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("unnest($2::uuid[],$3::text[])")
      ? [{ requested_id: artifactId, artifact_id: artifactId, representation_id: representation }]
      : [
          {
            artifact_id: artifactId,
            storage_state: "available",
            representation_id: representation,
            authorized,
            capture_root: false,
            report_version_id: null,
          },
        ],
  }));
  return { client: { query } as unknown as TenantSqlClient, query };
}
it("checks prepared input revocation after its signed exact source binding", async () => {
  const value = fixture("representation", false);
  await expect(assertSignedReportSourceDependencies(value.client, "tenant", [{ artifactId, digest }])).rejects.toThrow(
    "REPORT_SOURCE_DEPENDENCY_INELIGIBLE",
  );
});
it("preserves a native captured source independently of unrelated derived siblings", async () => {
  const value = fixture(null);
  await expect(
    assertSignedReportSourceDependencies(value.client, "tenant", [{ artifactId, digest }]),
  ).resolves.toBeUndefined();
  expect(value.query).toHaveBeenCalledTimes(1);
  expect(value.query.mock.calls[0]![0]).toContain("r.artifact_id=a.id and r.content_sha256=source.digest");
});
it("rejects missing exact source metadata instead of silently dropping it", async () => {
  const client = { query: async () => ({ rows: [] }) } as unknown as TenantSqlClient;
  await expect(assertSignedReportSourceDependencies(client, "tenant", [{ artifactId, digest }])).rejects.toThrow(
    "REPORT_SOURCE_DEPENDENCY_UNAVAILABLE",
  );
});
