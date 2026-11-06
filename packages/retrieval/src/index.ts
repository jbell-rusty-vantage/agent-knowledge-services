// vector-backends: exact and Postgres search adapters, exploratory publication,
// rollback, reconciliation, and space pointers.
export * from "./vector-backends/index.js";

// search: retrieve() is the pipeline orchestrator for policy-scoped planning,
// channel fusion, diversity, coverage, and immutable evidence-packet assembly.
// Plan and contract types are public; lexical, semantic, graph, and rerank stage
// primitives stay internal to the pipeline.
export * from "./search/index.js";

// embeddings: adapter contracts, vector validation, cache, wired gateway,
// and deterministic fake for offline tests and examples.
export * from "./embeddings/index.js";

// projections: validate evidence support, build domain projections, and classify
// their dispositions into vector spaces.
export * from "./projections/index.js";
