import {
  admitExtractionSchema,
  validateExtractionCandidate,
  type AdmittedExtractionSchema,
} from "../extraction/index.js";
import { preflightJson } from "./http.js";
import { ProviderFailure } from "./port.js";

const OUTPUT_SCHEMA_PREFLIGHT = {
  maximumNodes: 2_048,
  maximumDepth: 16,
  maximumCollection: 512,
  maximumStringBytes: 65_536,
} as const;

const OUTPUT_SCHEMA_LIMITS = {
  maxSchemaBytes: 32_768,
  maxDepth: 8,
  maxProperties: 128,
  maxEnumValues: 64,
  maxCandidateBytes: 64_000,
} as const;

/** Reuses the reviewed extraction schema gate; provider adapters never maintain a second grammar. */
export function admitOutputSchema(
  schema: unknown,
  schemaId = "provider_output",
  schemaVersion = "v1",
): AdmittedExtractionSchema {
  preflightJson(schema, OUTPUT_SCHEMA_PREFLIGHT);
  const admission = admitExtractionSchema({
    schemaId,
    schemaVersion,
    schema,
    limits: OUTPUT_SCHEMA_LIMITS,
  });
  if (!admission.admitted) throw new ProviderFailure("PROVIDER_CONFIGURATION_INVALID", false);
  return admission.schema;
}

export function validateOutputAgainstSchema(schema: AdmittedExtractionSchema, value: unknown): void {
  const result = validateExtractionCandidate(schema, value);
  if (!result.valid) throw new ProviderFailure("PROVIDER_RESPONSE_SCHEMA_INVALID", false);
}
