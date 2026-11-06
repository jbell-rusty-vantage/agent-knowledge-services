// `ks.knowledge_operation.v2` composition (SV-16): the transport-free K01 service, K07 credential validation, the backend
// port and registry (Sprint OC R5: the K05 and K06 backends are `BACKEND` registrations in their binding packages; the
// in-memory one is here as IN_MEMORY_BACKEND) and the env composition over a registry the executable passes in. Apps
// import this subpath (`@aiengineer/knowledge-host/knowledge-operation`) and keep only their HTTP/MCP adapters; the
// executable alone also imports the binding packages' `BACKEND` registrations to compose its registry.
export * from "./auth.js";
export * from "./backends.js";
export * from "./config.js";
export * from "./derive.js";
export * from "./errors.js";
export {
  BACKEND as IN_MEMORY_BACKEND,
  InMemoryEffectLedger,
  MemoryReportLocator,
  createInMemoryBackend,
} from "./in-memory.js";
export * from "./payloads.js";
export * from "./registry.js";
export type * from "./ports.js";
export * from "./service.js";
// The protocol and application values the transport adapters need, re-exported so apps never import them directly.
export { isTerminal, type ProtocolError } from "@aiengineer/knowledge-operation-protocol";
export type { AuditorDiscovery } from "@aiengineer/knowledge-application";
