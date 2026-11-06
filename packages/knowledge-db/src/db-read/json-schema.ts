import { UUID_PATTERN } from "./uuid.js";

/**
 * The subset of JSON Schema the named-query catalog uses for `params`: object shape,
 * `required`, `additionalProperties`, `type` (single or union), `enum`, numeric bounds,
 * string length, `items`, `format: uuid | date-time | date`, and `default`.
 */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}
export type JsonSchema = Readonly<Record<string, unknown>>;

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
const typeMatches = (declared: string, actual: string): boolean =>
  declared === actual || (declared === "number" && actual === "integer");

const FORMATS: Record<string, (value: string) => boolean> = {
  uuid: (value) => UUID_PATTERN.test(value),
  "date-time": (value) => !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
};

function checkType(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): boolean {
  const declared = schema.type;
  if (declared === undefined) return true;
  const allowed = Array.isArray(declared) ? (declared as string[]) : [String(declared)];
  const actual = typeOf(value);
  if (allowed.some((item) => typeMatches(item, actual))) return true;
  issues.push({ path, message: `expected ${allowed.join("|")}, got ${actual}` });
  return false;
}

function checkScalar(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value))
    issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      issues.push({ path, message: `must be ≥ ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum)
      issues.push({ path, message: `must be ≤ ${schema.maximum}` });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      issues.push({ path, message: `must have ≥ ${schema.minLength} characters` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issues.push({ path, message: `must have ≤ ${schema.maxLength} characters` });
    const format = typeof schema.format === "string" ? FORMATS[schema.format] : undefined;
    if (format && !format(value)) issues.push({ path, message: `must be a valid ${String(schema.format)}` });
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      issues.push({ path, message: `must match ${schema.pattern}` });
  }
}

function validateAt(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (!checkType(schema, value, path, issues)) return;
  if (value === null) return;
  if (Array.isArray(value)) {
    const items = schema.items;
    if (items && typeof items === "object")
      value.forEach((item, index) => validateAt(items as JsonSchema, item, `${path}[${index}]`, issues));
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      issues.push({ path, message: `must have ≤ ${schema.maxItems} items` });
    return;
  }
  if (typeof value === "object") {
    validateObject(schema, value as Record<string, unknown>, path, issues);
    return;
  }
  checkScalar(schema, value, path, issues);
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (value[key] === undefined) issues.push({ path: `${path}.${key}`.replace(/^\./, ""), message: "is required" });
  }
  for (const [key, item] of Object.entries(value)) {
    const child = properties[key];
    const childPath = path ? `${path}.${key}` : key;
    if (child) validateAt(child, item, childPath, issues);
    else if (schema.additionalProperties === false)
      issues.push({ path: childPath, message: "is not a declared parameter" });
  }
}

export function validateSchema(schema: JsonSchema, value: unknown): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateAt(schema, value, "", issues);
  return issues;
}

/** Fills declared `default`s for missing top-level properties; returns a new object. */
export function applyDefaults(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const filled: Record<string, unknown> = { ...value };
  for (const [key, child] of Object.entries(properties)) {
    if (filled[key] === undefined && "default" in child) filled[key] = child.default;
  }
  return filled;
}
