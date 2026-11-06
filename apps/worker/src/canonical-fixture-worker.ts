// Acceptance-only executable entry. The durable work itself is performed by
// the production Postgres lease/receipt adapter, while this file makes the
// process boundary unmistakably an apps/worker OS process.
process.env.CANONICAL_FIXTURE_MODE = "ingest";
const proofModule = new URL("../../../scripts/canonical-fixture.ts", import.meta.url);
await import(proofModule.href);
