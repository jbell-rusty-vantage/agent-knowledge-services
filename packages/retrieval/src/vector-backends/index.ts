// Backends — exact in-memory and Postgres vector search adapters.
export * from "./backends/index.js";

// Publication — exploratory publish, rollback, and reconciliation.
export * from "./publication/index.js";

// Spaces — publication version pointer types and the vector-item to entity link shape.
export * from "./spaces/index.js";

// Shared types — search request/candidate contracts and the backend error.
export * from "./types.js";
