// K02/K03: pure research domain and port contracts. Dependencies: K01 and zod only.
// No HTTP, SQL, graph driver, model call, orchestration SDK, filesystem or clock access: every timestamp is an input.
export * from "./digest.js";
export * from "./profiles/index.js";
export * from "./records/index.js";
export * from "./support/algebra.js";
export * from "./report/render.js";
export * from "./report/ledger.js";
export * from "./report/census.js";
export * from "./report/derive.js";
export * from "./report/kinds.js";
export * from "./verification/run.js";
export * from "./verification/manifest.js";
export * from "./verification/seal.js";
export * from "./verification/aggregate.js";
export * from "./verification/use-decision.js";
export * from "./verification/invalidation.js";
export type * from "./ports/scope.js";
export type * from "./ports/evidence.js";
export type * from "./ports/claim.js";
export type * from "./ports/verification.js";
export type * from "./ports/report.js";
export type * from "./ports/custody.js";
export * from "./ports/oracle.js";
export type * from "./ports/seal.js";
export * from "./authority/rules.js";
