import type { SqlClient } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { describe, expect, it } from "vitest";
import {
  type GrantDatabase,
  REVIEWER_ROLE,
  ReviewerGrantRefused,
  parseReviewerGrant,
  provisionReviewerGrant,
} from "./reviewer-grant.js";

const TENANT = "7f3e2d1c-0b9a-4876-9543-210fedcba987";
const FLAGS = {
  "database-url-env": "KS_AIENG_DB_COMPONENT_DSN",
  tenant: TENANT,
  reviewer: "reviewer:sprint-oc",
  "granted-by": "operator:sprint-oc",
  uses: "engineering_reference.model_facts,report_consumption",
  audiences: "internal,official",
  "report-kinds": "evidence_report",
};
const DB_NOW = "2026-10-28T12:00:00.000000Z";

/** Records each transaction's scope and statements; `existing` answers the live-grant lookup. */
function recording(existing: string | null) {
  const scopes: { tenantId: string; role: string }[] = [];
  const statements: { text: string; values: readonly unknown[] }[] = [];
  let ended = false;
  const client: SqlClient = {
    async query(text, values = []) {
      statements.push({ text, values });
      if (text.includes("now()")) return { rows: [{ now: DB_NOW }], rowCount: 1 } as never;
      if (text.startsWith("select grant_id")) {
        return { rows: existing ? [{ grant_id: existing }] : [], rowCount: existing ? 1 : 0 } as never;
      }
      return { rows: [{ grant_id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 } as never;
    },
  };
  const db: GrantDatabase = {
    async transaction(scope, work) {
      scopes.push(scope);
      return work(client);
    },
    async end() {
      ended = true;
    },
  };
  return { db, scopes, statements, ended: () => ended };
}

describe("grant-reviewer", () => {
  it("writes one grant under the reviewer role in the tenant scope, then is idempotent", async () => {
    const request = parseReviewerGrant(FLAGS);
    expect(request.scope).toEqual({
      uses: ["engineering_reference.model_facts", "report_consumption"],
      audiences: ["internal", "official"],
      reportKinds: ["evidence_report"],
    });
    const fresh = recording(null);
    const env = { KS_AIENG_DB_COMPONENT_DSN: "postgresql://login@127.0.0.1:5432/db" };
    const granted = await provisionReviewerGrant(request, env, () => fresh.db);
    expect(granted.status).toBe("granted");
    expect(fresh.scopes).toEqual([{ tenantId: TENANT, role: REVIEWER_ROLE }]);
    const insert = fresh.statements.find((item) =>
      item.text.startsWith("insert into knowledge_verification.reviewer_grant"),
    );
    expect(insert?.values.slice(0, 2)).toEqual([TENANT, "reviewer:sprint-oc"]);
    expect(insert?.values[4]).toBe(DB_NOW); // granted_at is the database clock
    expect(fresh.ended()).toBe(true);

    const again = recording("22222222-2222-4222-8222-222222222222");
    const existing = await provisionReviewerGrant(request, env, () => again.db);
    expect(existing).toMatchObject({ status: "existing", grantId: "22222222-2222-4222-8222-222222222222" });
    expect(again.statements.some((item) => item.text.startsWith("insert"))).toBe(false);
  });

  it("refuses the * wildcard unless --allow-wildcard is passed (least privilege)", () => {
    for (const name of ["uses", "audiences", "report-kinds"] as const) {
      expect(() => parseReviewerGrant({ ...FLAGS, [name]: "*" })).toThrow(/^SCOPE_WILDCARD_REFUSED: /);
    }
    const wide = parseReviewerGrant({ ...FLAGS, "report-kinds": "*", "allow-wildcard": true });
    expect(wide.scope.reportKinds).toEqual(["*"]);
  });

  it("refuses typed and never prints the DSN", async () => {
    const request = parseReviewerGrant(FLAGS);
    await expect(provisionReviewerGrant(request, {}, () => recording(null).db)).rejects.toThrow(
      /^DATABASE_URL_MISSING: KS_AIENG_DB_COMPONENT_DSN is not set$/,
    );
    for (const [name, value, code] of [
      ["tenant", "not-a-uuid", "ARGUMENT_INVALID"],
      ["reviewer", "has space", "ARGUMENT_INVALID"],
      ["uses", "Bad Name", "SCOPE_INVALID"],
      ["audiences", " ", "ARGUMENT_REQUIRED"],
      ["database-url-env", "postgresql://x", "ARGUMENT_INVALID"],
    ] as const) {
      const refused = (() => {
        try {
          parseReviewerGrant({ ...FLAGS, [name]: value });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(refused).toBeInstanceOf(ReviewerGrantRefused);
      expect((refused as ReviewerGrantRefused).code).toBe(code);
    }
    const { "report-kinds": _omitted, ...missing } = FLAGS;
    expect(() => parseReviewerGrant(missing)).toThrow(/ARGUMENT_REQUIRED: --report-kinds/);
  });
});
