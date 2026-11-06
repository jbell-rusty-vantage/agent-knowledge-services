import {
  ComponentDatabase,
  type SqlClient,
  assertTenantId,
  grantReviewer,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";

/**
 * `knowledge-verify grant-reviewer`: provision one live reviewer grant in the `knowledge_verification` component
 * (OVE-169 W1). `report.review` refuses `SCOPE_DENIED / reviewer_not_qualified` unless a live grant whose scope covers
 * the decision's use, audience and report kind names the reviewer (the K01 credential subject Mission Control sends:
 * its review route's authenticated actor id, e.g. `reviewer:sprint-oc`). The grant is written under the bounded
 * `knowledge_verification_reviewer` role in the tenant's RLS context, through the binding's `grantReviewer` store.
 *
 * Idempotent: a live grant of the same reviewer with exactly the same scope is reported (`existing`) and nothing is
 * written. The DSN is read from the environment variable `--database-url-env` names (never a flag value, never
 * printed). Scope lists are comma-separated and every list is required (`{}` qualifies for nothing). Least privilege:
 * the component's `*` wildcard is refused (`SCOPE_WILDCARD_REFUSED`) unless `--allow-wildcard` is passed. `granted_at`
 * is the database's `now()`, never the caller's clock.
 *
 * Independence is not this grant's job: at review time KS refuses a reviewer who is the producer (`assertIndependent`
 * in packages/host/src/knowledge-operation/assessment.ts reads the producer from the decision's stored run context:
 * `INDEPENDENCE_UNPROVEN / reviewer_is_producer`), even one holding a live grant; Mission Control's review route also
 * refuses the run's launcher, revision authors, producer and evaluators before it sends anything.
 */
export const REVIEWER_ROLE = "knowledge_verification_reviewer" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const NAME = /^(\*|[a-z][a-z0-9_.-]{0,119})$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface ReviewerGrantScope {
  readonly uses: readonly string[];
  readonly audiences: readonly string[];
  readonly reportKinds: readonly string[];
}

export interface ReviewerGrantRequest {
  readonly databaseUrlEnv: string;
  readonly tenantId: string;
  readonly reviewerId: string;
  readonly grantedBy: string;
  readonly scope: ReviewerGrantScope;
}

/** The narrow database seam (`ComponentDatabase` in production; a recording double in tests). */
export interface GrantDatabase {
  transaction<T>(
    scope: { tenantId: string; role: typeof REVIEWER_ROLE },
    work: (client: SqlClient) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
}

export class ReviewerGrantRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReviewerGrantRefused";
  }
}

type Flags = Readonly<Record<string, string | boolean | undefined>>;

function flag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewerGrantRefused("ARGUMENT_REQUIRED", `--${name} is required`);
  }
  return value.trim();
}

function names(flags: Flags, name: string, allowWildcard: boolean): string[] {
  const values = flag(flags, name)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (values.length === 0 || values.some((item) => !NAME.test(item))) {
    throw new ReviewerGrantRefused("SCOPE_INVALID", `--${name} must list names or *`);
  }
  if (!allowWildcard && values.includes("*")) {
    throw new ReviewerGrantRefused(
      "SCOPE_WILDCARD_REFUSED",
      `--${name} names *; list the exact names (or pass --allow-wildcard)`,
    );
  }
  return [...new Set(values)].sort();
}

export function parseReviewerGrant(flags: Flags): ReviewerGrantRequest {
  const wildcard = flags["allow-wildcard"] === true;
  const databaseUrlEnv = flag(flags, "database-url-env");
  if (!ENV_NAME.test(databaseUrlEnv)) {
    throw new ReviewerGrantRefused("ARGUMENT_INVALID", "--database-url-env names an environment variable");
  }
  const tenantId = flag(flags, "tenant");
  try {
    assertTenantId(tenantId);
  } catch {
    throw new ReviewerGrantRefused("ARGUMENT_INVALID", "--tenant must be a tenant UUID");
  }
  const reviewerId = flag(flags, "reviewer");
  const grantedBy = flag(flags, "granted-by");
  for (const [label, value] of [
    ["reviewer", reviewerId],
    ["granted-by", grantedBy],
  ] as const) {
    if (!ID.test(value)) throw new ReviewerGrantRefused("ARGUMENT_INVALID", `--${label} is not a K01 id`);
  }
  return {
    databaseUrlEnv,
    tenantId,
    reviewerId,
    grantedBy,
    scope: {
      uses: names(flags, "uses", wildcard),
      audiences: names(flags, "audiences", wildcard),
      reportKinds: names(flags, "report-kinds", wildcard),
    },
  };
}

export interface ReviewerGrantResult {
  readonly status: "granted" | "existing";
  readonly grantId: string;
  readonly tenantId: string;
  readonly reviewerId: string;
  readonly scope: ReviewerGrantScope;
}

export async function provisionReviewerGrant(
  request: ReviewerGrantRequest,
  env: Readonly<Record<string, string | undefined>>,
  open: (connectionString: string) => GrantDatabase = (connectionString) =>
    new ComponentDatabase({ connectionString, applicationName: "knowledge-verify-grant-reviewer" }),
): Promise<ReviewerGrantResult> {
  const dsn = env[request.databaseUrlEnv]?.trim();
  if (!dsn) throw new ReviewerGrantRefused("DATABASE_URL_MISSING", `${request.databaseUrlEnv} is not set`);
  const db = open(dsn);
  try {
    return await db.transaction({ tenantId: request.tenantId, role: REVIEWER_ROLE }, async (client) => {
      const scope = JSON.stringify(request.scope);
      const live = await client.query<{ grant_id: string }>(
        "select grant_id::text as grant_id from knowledge_verification.reviewer_grant where tenant_id = $1 and reviewer_id = $2 and revoked_at is null and scope = $3::jsonb order by granted_at limit 1",
        [request.tenantId, request.reviewerId, scope],
      );
      const existing = live.rows[0];
      const base = { tenantId: request.tenantId, reviewerId: request.reviewerId, scope: request.scope };
      if (existing) return { status: "existing", grantId: existing.grant_id, ...base };
      // The database clock, never the caller's.
      const clock = await client.query<{ now: string }>(
        `select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
      );
      const grantedAt = clock.rows[0]?.now;
      if (!grantedAt) throw new ReviewerGrantRefused("CLOCK_UNAVAILABLE", "the database answered no now()");
      const grantId = await grantReviewer(client, request.tenantId, {
        reviewerId: request.reviewerId,
        scope: request.scope as never,
        grantedBy: request.grantedBy,
        grantedAt,
      });
      return { status: "granted", grantId, ...base };
    });
  } finally {
    await db.end();
  }
}
