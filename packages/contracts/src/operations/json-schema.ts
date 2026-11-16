import { z } from "zod";

/** A JSON Schema document or fragment. */
export type JsonSchema = { readonly [keyword: string]: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Removes what a reader does not need: the `$schema` marker, the pattern that restates a `format` and the
 * safe-integer bounds that every integer carries.
 */
function tidy(value: unknown, root = true): unknown {
  if (Array.isArray(value)) return value.map((item) => tidy(item, false));
  if (!isObject(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (root && key === "$schema") continue;
    if (key === "pattern" && typeof value.format === "string") continue;
    if (key === "minimum" && child === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && child === Number.MAX_SAFE_INTEGER) continue;
    output[key] = tidy(child, false);
  }
  return output;
}

/**
 * The JSON Schema (draft 2020-12) of what a caller sends for this schema. Fields with a default are optional.
 * Cross-field rules written as refinements cannot be expressed and are documented beside the schema as notes.
 */
export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  return tidy(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" })) as JsonSchema;
}

/** The JSON Schema (draft 2020-12) of a value the service returns. */
export function outputJsonSchema(schema: z.ZodType): JsonSchema {
  return tidy(z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", unrepresentable: "any" })) as JsonSchema;
}

/**
 * A short form of a JSON Schema: the required fields and their types down to `depth` levels of nesting, with
 * literals and closed value lists kept. Optional fields, lengths, bounds and patterns are left to the full schema.
 */
export function compactJsonSchema(schema: JsonSchema, depth: number): JsonSchema {
  const definitions = isObject(schema.$defs) ? schema.$defs : {};
  const resolve = (node: unknown): Record<string, unknown> => {
    if (!isObject(node)) return {};
    if (typeof node.$ref !== "string") return node;
    const target = definitions[node.$ref.replace("#/$defs/", "")];
    // A recursive definition (any JSON value) has no compact form.
    return isObject(target) && !JSON.stringify(target).includes(node.$ref) ? target : {};
  };
  const compact = (value: unknown, remaining: number): Record<string, unknown> => {
    const node = resolve(value);
    if ("const" in node) return { const: node.const };
    if (Array.isArray(node.enum)) return remaining > 0 ? { enum: node.enum } : { type: "string" };
    const variants = [node.anyOf, node.oneOf].find(Array.isArray) as unknown[] | undefined;
    if (variants) {
      const forms = variants.map((variant) => compact(variant, remaining));
      const types = new Set(forms.map((form) => form.type));
      if (remaining > 0 && forms.every((form) => form.type === "object" && form.properties !== undefined))
        return { anyOf: forms };
      return types.size === 1 && typeof forms[0]?.type === "string" ? { type: forms[0].type } : {};
    }
    if (node.type === "object") {
      const properties = isObject(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      // An object that takes no fields at all says so, to tell it apart from one whose fields are left out.
      if (Object.keys(properties).length === 0 && node.additionalProperties === false)
        return { type: "object", additionalProperties: false };
      if (remaining <= 0 || required.length === 0) return { type: "object" };
      return {
        type: "object",
        required,
        properties: Object.fromEntries(required.map((name) => [name, compact(properties[name], remaining - 1)])),
      };
    }
    if (node.type === "array")
      return remaining > 0 && node.items !== undefined
        ? { type: "array", items: compact(node.items, remaining - 1) }
        : { type: "array" };
    return typeof node.type === "string" ? { type: node.type } : {};
  };
  return compact(schema, depth);
}
