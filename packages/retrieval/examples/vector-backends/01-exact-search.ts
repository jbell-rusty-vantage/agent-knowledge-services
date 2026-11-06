import { InMemoryExactCosineBackend } from "../../src/index.js";
import { id, printJson, vector } from "./fixtures.js";

/**
 * Isolation is a filter predicate here, not a separate index per tenant or
 * version: this example proves the predicates (tenant, vector-space version,
 * lifecycle) hold rather than trusting that a single shared map behaves like
 * several. Ordering is score-desc then id-asc, so a tie is deterministic.
 */
export async function exactSearchExample() {
  const tenant = id(1);
  const otherTenant = id(2);
  const version = id(3);
  const otherVersion = id(4);
  const backend = new InMemoryExactCosineBackend([
    {
      tenantId: tenant,
      vectorSpaceVersionId: version,
      vectorSpaceKey: "claims",
      vectorItemId: "match-a",
      embedding: vector({ 0: 1 }),
    },
    {
      tenantId: tenant,
      vectorSpaceVersionId: version,
      vectorSpaceKey: "claims",
      vectorItemId: "match-b",
      embedding: vector({ 0: 1 }),
    },
    {
      tenantId: tenant,
      vectorSpaceVersionId: version,
      vectorSpaceKey: "claims",
      vectorItemId: "orthogonal",
      embedding: vector({ 1: 1 }),
    },
    {
      tenantId: tenant,
      vectorSpaceVersionId: version,
      vectorSpaceKey: "claims",
      vectorItemId: "withdrawn",
      embedding: vector({ 0: 1 }),
      lifecycle: "withdrawn",
    },
    {
      tenantId: otherTenant,
      vectorSpaceVersionId: version,
      vectorSpaceKey: "claims",
      vectorItemId: "hidden-tenant",
      embedding: vector({ 0: 1 }),
    },
    {
      tenantId: tenant,
      vectorSpaceVersionId: otherVersion,
      vectorSpaceKey: "claims",
      vectorItemId: "hidden-version",
      embedding: vector({ 0: 1 }),
    },
  ]);
  const query = { tenantId: tenant, vectorSpaceVersionId: version, embedding: vector({ 0: 1 }), limit: 5 };
  const first = await backend.search(query);
  const second = await backend.search(query);
  return {
    visibleItemIds: first.map(({ vectorItemId }) => vectorItemId),
    deterministic: JSON.stringify(first) === JSON.stringify(second),
  };
}

if (process.argv[1]?.includes("01-exact-search")) exactSearchExample().then(printJson);
