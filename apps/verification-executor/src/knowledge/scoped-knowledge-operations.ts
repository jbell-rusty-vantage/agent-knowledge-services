import { z } from "zod";
import { getPage, searchWorkspace } from "@aiengineer/knowledge-db";
import { ScopedAccessError, scopedCustodyOperations, type ScopedOperation } from "../access.js";
import type { KnowledgeServices } from "./context.js";

interface ScopedContext {
  readonly tenantId: string;
  requireRead(resourceId: string): void;
}

/**
 * Narrow knowledge reads a pinned child may hold, beside the custody operations. Each one binds to
 * the assignment's tenant and, where it names a record, to the assignment's read scope. Nothing here
 * writes: canonical apply stays with the host, which owns the original questions, budgets and authority. The full operation
 * registry is never exposed to a child.
 */
export function scopedKnowledgeOperations(knowledge: KnowledgeServices): readonly ScopedOperation[] {
  const operation = <T extends z.ZodType>(
    name: string,
    schema: T,
    execute: (context: ScopedContext, payload: z.infer<T>) => Promise<unknown>,
  ): ScopedOperation => ({
    name,
    input: schema,
    execute: (scope, payload) => {
      if (scope.assignment.tenantId !== knowledge.config.defaultTenantId)
        throw new ScopedAccessError("SCOPED_TENANT_BINDING");
      return execute(
        { tenantId: knowledge.config.defaultTenantId, requireRead: (id) => scope.requireRead(id) },
        schema.parse(payload),
      );
    },
  });

  return [
    operation(
      "schema_search",
      z.strictObject({
        query: z.string().min(1).max(200),
        kinds: z.array(z.string().min(1).max(64)).max(16).optional(),
        domain: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      async (_context, payload) =>
        searchWorkspace(knowledge.workspace, payload.query, {
          ...(payload.kinds ? { kinds: payload.kinds } : {}),
          ...(payload.domain ? { domain: payload.domain } : {}),
          ...(payload.limit ? { limit: payload.limit } : {}),
        }),
    ),

    operation(
      "schema_get",
      z.strictObject({
        id: z.string().min(1).max(300),
        maxBytes: z.number().int().min(256).max(64_000).optional(),
      }),
      async (_context, payload) =>
        getPage(knowledge.workspace, payload.id, payload.maxBytes ? { maxBytes: payload.maxBytes } : {}),
    ),

    operation("db_head", z.strictObject({}), async (context) => ({
      tenantId: context.tenantId,
      knowledgeHead: await knowledge.reads.head(context.tenantId),
      migrationHead: await knowledge.reads.databaseHead(),
      workspaceHead: knowledge.workspace.migrationHead,
    })),

    operation("artifact_get", z.strictObject({ artifactId: z.uuid() }), async (context, payload) => {
      context.requireRead(payload.artifactId);
      return knowledge.artifacts.get(context.tenantId, payload.artifactId);
    }),
  ];
}

/**
 * Names and JSON Schema inputs of every operation a scoped child can be granted, with no database,
 * executor or recovery host attached: the factories dereference their services only inside
 * `execute`, which this never calls. A harness generates a child's tool catalog from this instead of
 * hand-writing an operation list, and the schemas are identical to the ones
 * `ScopedExecutorAccess.catalog` returns for a granted assignment.
 */
export function scopedOperationCatalog(): readonly { name: string; inputSchema: unknown }[] {
  const unattached = undefined as never;
  return [...scopedCustodyOperations(unattached), ...scopedKnowledgeOperations(unattached)]
    .map((operation) => ({ name: operation.name, inputSchema: z.toJSONSchema(operation.input) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
