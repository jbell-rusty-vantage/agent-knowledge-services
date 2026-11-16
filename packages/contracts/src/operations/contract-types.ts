import { z } from "zod";
import { OperationContextSchema } from "../identity.js";
import { AcceptedOperationSchema, type OperationKind } from "../integration.js";
import { VerificationOperationContextHintsSchema } from "../verification/requests.js";

/** How one operation's input travels in the arguments of its MCP tool. */
export type ArgumentShape =
  /** `{ context: OperationContext, input, expectedVersions }` */
  | "envelope"
  /** `{ context: { tenantId, correlationId, idempotencyKey, ...hints }, request }` */
  | "request"
  /** `{ context: { tenantId, correlationId }, ...input }` */
  | "flat"
  /** The input itself. */
  | "bare";

/** What a call returns at once, and what the operation produces when it finishes. */
export interface OperationResult {
  /** Name of the returned shape. */
  readonly name: string;
  /** Schema of the returned value, when the contract package defines one. */
  readonly schema?: z.ZodType;
  /** For a submitted operation: what its steps record on success. For a read: what the fields mean. */
  readonly outcome: string;
}

/**
 * Everything a caller needs to know about one operation, written once. The MCP tool description, the
 * `ks --help` text and the OpenAPI summary are these strings; `describe` returns the rest on demand.
 */
export interface OperationContract {
  /** The durable operation kind, or the name of a read. `describe` accepts it as `operation:<name>`. */
  readonly operation: string;
  readonly kind?: OperationKind;
  /** `submit` admits a durable operation, `read` returns stored state, `control` changes state and answers at once. */
  readonly effect: "submit" | "read" | "control";
  /** What it does, in one line. */
  readonly summary: string;
  /** When to use it rather than its neighbour. */
  readonly when: string;
  /** The result and what to call next. */
  readonly returns: string;
  /** The typed input every transport accepts. */
  readonly input: z.ZodType;
  readonly shape: ArgumentShape;
  /** What the schema cannot express: cross-field rules, units, allowed combinations, required authority. */
  readonly notes: readonly string[];
  /** One minimal input that satisfies `input`. */
  readonly example: unknown;
  readonly result: OperationResult;
  /** Refs of the operations a caller usually needs beside this one. */
  readonly related: readonly string[];
  /** MCP tools that run this operation. The first is the operation's own tool; the others are named in `aliases`. */
  readonly mcp: readonly string[];
  /** `ks` commands (without the binary) that run this operation. */
  readonly cli: readonly string[];
  /** HTTP routes (`METHOD /path`, OpenAPI path form) that run this operation. */
  readonly http: readonly string[];
  /** Description lines of the tools in `mcp` that are another name for this operation. */
  readonly aliases?: Readonly<Record<string, Pick<OperationContract, "summary" | "when" | "returns">>>;
}

/** Read context of the MCP tools that take ids beside it. */
export const ToolReadContextSchema = z.strictObject({
  tenantId: z.uuid(),
  correlationId: z.string().trim().min(1).max(255),
});

/** Context of the MCP verification submissions: the read context, an idempotency key and optional routing hints. */
export const VerificationToolContextSchema = ToolReadContextSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(255),
  ...VerificationOperationContextHintsSchema.shape,
});

/** Arguments of an MCP tool whose input travels as `{ context, input, expectedVersions }`. */
export const envelopeArguments = (input: z.ZodType) =>
  z.object({
    context: OperationContextSchema,
    input,
    expectedVersions: z.record(z.string(), z.string().min(1)),
  });

/** The arguments an MCP tool of this operation takes. */
export function toolArgumentsSchema(contract: Pick<OperationContract, "input" | "shape">): z.ZodType {
  if (contract.shape === "envelope") return envelopeArguments(contract.input);
  if (contract.shape === "request")
    return z.strictObject({ context: VerificationToolContextSchema, request: contract.input });
  if (contract.shape === "flat")
    return z.strictObject({
      context: ToolReadContextSchema,
      ...(contract.input as z.ZodObject<z.ZodRawShape>).shape,
    });
  return contract.input;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Identifiers and digests used by the examples. They name nothing real. */
export const EXAMPLE = Object.freeze({
  id,
  digest: (character: string) => `sha256:${character.repeat(64)}`,
  tenantId: id(1),
  at: "2026-01-15T12:00:00Z",
});

/** A valid `OperationContext`: who is calling, for which tenant, and the operation and attempt it starts. */
export const EXAMPLE_OPERATION_CONTEXT = Object.freeze({
  tenantId: EXAMPLE.tenantId,
  operationId: id(2),
  attemptId: id(3),
  correlationId: "example-correlation-1",
  actor: { kind: "service", id: id(4), serviceIdentity: "mission_control_client" },
  capabilityVersion: "mcp/1",
  idempotencyKey: "example-key-0001",
  reason: "why this operation is requested",
  contractVersion: "v1",
});
export const EXAMPLE_READ_CONTEXT = Object.freeze({
  tenantId: EXAMPLE.tenantId,
  correlationId: "example-correlation-1",
});
export const EXAMPLE_VERIFICATION_CONTEXT = Object.freeze({
  ...EXAMPLE_READ_CONTEXT,
  idempotencyKey: "example-key-0001",
});

/** One valid set of arguments for an MCP tool of this operation. */
export function toolArgumentsExample(contract: Pick<OperationContract, "example" | "shape">): unknown {
  if (contract.shape === "envelope")
    return { context: EXAMPLE_OPERATION_CONTEXT, input: contract.example, expectedVersions: { api: "v1" } };
  if (contract.shape === "request") return { context: EXAMPLE_VERIFICATION_CONTEXT, request: contract.example };
  if (contract.shape === "flat") return { context: EXAMPLE_READ_CONTEXT, ...(contract.example as object) };
  return contract.example;
}

/** What every submission returns at once. */
export const acceptedResult = (outcome: string): OperationResult => ({
  name: "AcceptedOperation",
  schema: AcceptedOperationSchema,
  outcome,
});

/** Notes shared by the operations submitted with `{ context, input, expectedVersions }`. */
export const ENVELOPE_NOTES = Object.freeze([
  "context.actor must be the caller the bearer token identifies; context.tenantId must be a tenant that token may act for.",
  "context.operationId is the id of the operation this call creates. Repeating the call with the same context.idempotencyKey (8 to 255 characters) and the same input returns that operation; the same key with another input, or a reused operationId, is refused with IDEMPOTENCY_CONFLICT.",
  'expectedVersions needs at least one entry, for example { "api": "v1" }.',
]);
