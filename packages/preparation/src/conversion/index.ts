// Contract and constants
export * from "./constants.js";
export * from "./types.js";

// Route — text → Docling → gated Unstructured
// Media-type classification decides the candidate route; ConversionRouter and
// conversionRouterFromProviders reach this barrel through ./providers.js below.
export * from "./media-type.js";

// Providers
export * from "./deterministic.js";
export * from "./providers.js";

// HTTP clients
export * from "./http-clients.js";

// Isolated verification parser
export * from "./verification-parser.js";
