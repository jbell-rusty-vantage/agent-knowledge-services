// Identity — content-derived node ids.
export { deterministicUuid } from "./identity/index.js";

// Nodes — sealed, immutable DocumentNodes from structural blocks.
export { convertStructuralDocument, normalizeDocumentText } from "./nodes/index.js";

// Locators — quote-bound source locators and their verification.
export { createSourceLocator, reconstructNodeSpan, verifyNodeLocators } from "./locators/index.js";

// Input and output shapes owned by this package.
export type { StructuralBlock, StructuralDocument, StructuralDocumentInput } from "./types.js";
