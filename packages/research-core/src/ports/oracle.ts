import {
  type Digest,
  type JsonValue,
  NameSchema,
  type Ref,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import type { UseDecision } from "../records/decision.js";
import type { AuthScope } from "./scope.js";

/** A safe integer (OQ2): canonical bytes carry no floats; decimals are decimal strings with units in separate keys. */
export type SafeInteger = number & { readonly __safeInteger: unique symbol };

export function safeInteger(value: number): SafeInteger {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not a safe integer: ${value}`);
  return value as SafeInteger;
}

/** OQ2: `Record<name, string | safe integer | boolean | null>`; nested objects and floats are refused. */
export type NormalizedValue = string | SafeInteger | boolean | null;
export type NormalizedValues = Readonly<Record<string, NormalizedValue>>;

export const NormalizedValuesSchema = z.record(
  NameSchema,
  z.union([z.string(), z.int().refine(Number.isSafeInteger), z.boolean(), z.null()]),
);

/** The digest a use decision binds and `admit_exact_use(p_normalized_values_digest)` compares. */
export function normalizedValuesDigest(values: Readonly<Record<string, string | number | boolean | null>>): Digest {
  return digestCanonical(NormalizedValuesSchema.parse(values) as unknown as JsonValue);
}

/** An exact-use request: every binding the resulting decision will carry. */
export interface ExactUseRequest {
  readonly subject: Ref<"assertion" | "report">;
  readonly report: Ref<"report">;
  readonly qualifiersDigest: Digest | null;
  readonly supportSet: Ref<"support_set"> | null;
  readonly run: Ref<"verification_run">;
  readonly boundEffectDigest: Digest;
  readonly use: string;
  readonly audience: string;
  readonly normalizedValues: NormalizedValues;
  readonly targetSchema: string;
  readonly policy: Ref<"policy">;
  readonly rubric: Ref<"rubric">;
}

/** The decision plus the authority state `admissible` needs; `authoritativeEpoch` null means authority unavailable. */
export interface AuthoritativeDecision {
  readonly decision: UseDecision;
  readonly authoritativeEpoch: number | null;
  readonly processedEpoch: number;
  readonly closureComplete: boolean;
  readonly invalidated: boolean;
}

/** `EvidenceOracle` (design §4): the single admission authority per installation. */
export interface EvidenceOracle {
  hydrate(scope: AuthScope, decision: Ref<"use_decision">): Promise<AuthoritativeDecision>;
  admit(scope: AuthScope, request: ExactUseRequest): Promise<UseDecision>;
}
