import { domainError } from "../schema-workspace/index.js";

/**
 * Admits exactly one `SELECT` / `WITH … SELECT` statement for the read-only SQL surface.
 * The transaction is `read only` under `pipeline_agent` regardless; this guard turns the
 * obvious misuse into readable refusals and blocks the one function that could move the
 * tenant context inside an otherwise read-only statement (`set_config`).
 */
const MAX_SQL_CHARS = 20_000;
const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|vacuum|reindex|cluster|lock)\b/i;
const CONTEXT_MUTATORS = /\b(set_config|pg_advisory_lock|pg_terminate_backend|pg_cancel_backend)\s*\(/i;

function stripCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function assertSingleReadStatement(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement) throw domainError("SQL_EMPTY", "sql is empty");
  if (statement.length > MAX_SQL_CHARS) throw domainError("SQL_TOO_LONG", `sql exceeds ${MAX_SQL_CHARS} characters`);
  const stripped = stripCommentsAndLiterals(statement);
  if (stripped.includes(";")) throw domainError("SQL_MULTI_STATEMENT", "exactly one statement is allowed");
  if (!/^\s*(select|with)\b/i.test(stripped))
    throw domainError("SQL_NOT_SELECT", "only a single SELECT or WITH … SELECT statement is allowed");
  const write = WRITE_KEYWORDS.exec(stripped);
  if (write) throw domainError("SQL_FORBIDDEN_KEYWORD", `keyword not allowed on the read surface: ${write[1]}`);
  const mutator = CONTEXT_MUTATORS.exec(stripped);
  if (mutator) throw domainError("SQL_FORBIDDEN_FUNCTION", `function not allowed on the read surface: ${mutator[1]}`);
  return statement;
}
