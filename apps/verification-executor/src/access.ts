import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { VerificationExecutor } from "./executor.js";
import { CaptureFragmentInputSchema } from "./knowledge-operation/capture-bridge.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const identifiers = z
  .array(identifier)
  .max(128)
  .refine((items) => new Set(items).size === items.length);
const assignmentSchema = z
  .object({
    tenantId: identifier,
    callerId: identifier,
    runId: identifier,
    parentSessionId: identifier,
    assignmentId: identifier,
    producerAttemptId: identifier,
    role: identifier,
    pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
    grantId: identifier,
    readScope: identifiers,
    allowedOperations: identifiers.min(1),
    namespace: z.string(),
    deadline: z.iso.datetime({ offset: true }),
  })
  .passthrough();

export type ScopedAssignment = z.infer<typeof assignmentSchema>;

export class ScopedAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScopedAccessError";
  }
}

interface OperationScope {
  readonly assignment: ScopedAssignment;
  requireRead(resourceId: string): void;
  retain(resourceId: string): void;
}

export interface ScopedOperation {
  readonly name: string;
  readonly input: z.ZodType;
  execute(scope: OperationScope, payload: unknown): Promise<unknown>;
}

interface InstalledGrant {
  readonly assignment: ScopedAssignment;
  readonly operations: ReadonlyMap<string, ScopedOperation>;
  readonly retained: Set<string>;
  revoked: boolean;
}

export interface GrantInstallation {
  readonly assignment: unknown;
  readonly operations: readonly ScopedOperation[];
  /** Host restores these only after independently verifying checkpoint receipts and namespace. */
  readonly restoredArtifactIds?: readonly string[];
}

/** Host configuration supplies grants and executable adapters; no request can install either. */
export class ScopedExecutorAccess {
  private readonly grants = new Map<string, InstalledGrant>();

  constructor(input: {
    grants: readonly GrantInstallation[];
    now?: () => number;
  }) {
    this.now = input.now ?? Date.now;
    for (const grant of input.grants) this.installGrant(grant);
  }

  private readonly now: () => number;

  /** Trusted host only; installed after the actual parent session is known. */
  installGrant(input: GrantInstallation): void {
    const assignment = assignmentSchema.parse(structuredClone(input.assignment));
    if (assignment.namespace !== `${assignment.tenantId}/${assignment.runId}/${assignment.assignmentId}`) {
      throw new ScopedAccessError("SCOPED_NAMESPACE_BINDING");
    }
    if (this.grants.has(assignment.grantId)) throw new ScopedAccessError("SCOPED_GRANT_DUPLICATE");
    const operations = new Map(input.operations.map((operation) => [operation.name, { ...operation }]));
    if (operations.size !== input.operations.length) throw new ScopedAccessError("SCOPED_OPERATION_DUPLICATE");
    if (assignment.allowedOperations.some((name) => !operations.has(name)))
      throw new ScopedAccessError("SCOPED_OPERATION_NOT_INSTALLED");
    const retained = new Set(identifiers.parse(input.restoredArtifactIds ?? []));
    this.grants.set(assignment.grantId, { assignment, operations, retained, revoked: false });
  }

  private requireGrant(input: unknown): InstalledGrant {
    const assignment = assignmentSchema.parse(input);
    const grant = this.grants.get(assignment.grantId);
    if (!grant || grant.revoked || !isDeepStrictEqual(grant.assignment, assignment))
      throw new ScopedAccessError("SCOPED_GRANT_UNAUTHORIZED");
    if (this.now() >= Date.parse(grant.assignment.deadline)) throw new ScopedAccessError("SCOPED_GRANT_EXPIRED");
    return grant;
  }

  async authorizeGrant(assignment: unknown): Promise<void> {
    this.requireGrant(assignment);
  }

  catalog(assignment: unknown): { operations: { name: string; inputSchema: unknown }[]; sha256: string } {
    const grant = this.requireGrant(assignment);
    const operations = [...grant.assignment.allowedOperations].sort().map((name) => ({
      name,
      inputSchema: z.toJSONSchema(grant.operations.get(name)!.input),
    }));
    return { operations, sha256: createHash("sha256").update(JSON.stringify(operations)).digest("hex") };
  }

  revoke(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) grant.revoked = true;
  }

  async executeScoped(input: { assignment: unknown; operation: string; payload: unknown }): Promise<unknown> {
    const grant = this.requireGrant(input.assignment);
    if (!grant.assignment.allowedOperations.includes(input.operation))
      throw new ScopedAccessError("SCOPED_OPERATION_FORBIDDEN");
    const operation = grant.operations.get(input.operation)!;
    const payload = operation.input.parse(structuredClone(input.payload));
    const scope: OperationScope = {
      assignment: structuredClone(grant.assignment),
      requireRead: (id) => {
        if (!grant.assignment.readScope.includes(id) && !grant.retained.has(id))
          throw new ScopedAccessError("SCOPED_RESOURCE_FORBIDDEN");
      },
      retain: (id) => {
        grant.retained.add(id);
      },
    };
    return operation.execute(scope, payload);
  }
}

function operation<T extends z.ZodType>(input: {
  name: string;
  schema: T;
  execute: (scope: OperationScope, payload: z.infer<T>) => Promise<unknown>;
}): ScopedOperation {
  return {
    name: input.name,
    input: input.schema,
    execute: (scope, payload) => input.execute(scope, input.schema.parse(payload)),
  };
}

function requireExecutor(scope: OperationScope, executor: VerificationExecutor): void {
  if (
    executor.store.tenantId !== scope.assignment.tenantId ||
    executor.config.producerAttemptId !== scope.assignment.producerAttemptId
  ) {
    throw new ScopedAccessError("SCOPED_EXECUTOR_BINDING");
  }
}

/** Local custody operations only. Provider calls and graph writes need their own admitted adapters. */
export function scopedCustodyOperations(executor: VerificationExecutor): readonly ScopedOperation[] {
  return [
    operation({
      name: "verify_capture_fragment",
      schema: CaptureFragmentInputSchema,
      execute: async (scope, payload) => {
        requireExecutor(scope, executor);
        scope.requireRead(payload.captureId);
        const result = await executor.captureFragment(payload, scope.assignment.runId);
        for (const id of [result.fragment.capture.id, result.fragment.representation.id, result.provenance.artifactId])
          scope.retain(id);
        return result;
      },
    }),
    operation({
      name: "verify_read_capture",
      schema: z.strictObject({
        captureId: identifier,
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().min(1).max(20_000).optional(),
      }),
      execute: async (scope, payload) => {
        requireExecutor(scope, executor);
        scope.requireRead(payload.captureId);
        return executor.readCapture(payload);
      },
    }),
    operation({
      name: "verify_get_artifact",
      schema: z.strictObject({
        artifactId: identifier,
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(20_000).default(6000),
      }),
      execute: async (scope, payload) => {
        requireExecutor(scope, executor);
        scope.requireRead(payload.artifactId);
        const handle = await executor.store.resolveHandle({ artifactId: payload.artifactId });
        const text = await executor.store.text(handle);
        return {
          handle,
          offset: payload.offset,
          totalCharacters: text.length,
          text: text.slice(payload.offset, payload.offset + payload.length),
          hasMore: payload.offset + payload.length < text.length,
        };
      },
    }),
    operation({
      name: "verify_register_artifact",
      schema: z.strictObject({
        text: z.string().max(1_000_000),
        mediaType: z.string().min(1).max(120),
        name: identifier,
      }),
      execute: async (scope, payload) => {
        requireExecutor(scope, executor);
        const result = await executor.registerArtifact({
          bytes: new TextEncoder().encode(payload.text),
          mediaType: payload.mediaType,
          label: `${scope.assignment.namespace}/${payload.name}`,
          runId: scope.assignment.runId,
          dataClassification: "internal",
        });
        scope.retain(result.artifactId);
        return {
          ...result,
          namespace: scope.assignment.namespace,
          producerAttemptId: scope.assignment.producerAttemptId,
        };
      },
    }),
  ];
}
