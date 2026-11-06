/**
 * Frozen compatibility surface for the pre-KS verification prototype.
 * Behavior here is legacy by definition: it is not part of the verification
 * pipeline and must not be extended. Import via
 * `@aiengineer/knowledge-verification/prototype-compat`.
 */
export {
  replayPrototypeArithmetic,
  type PrototypeArithmeticExpression,
} from "./arithmetic.js";
export { verifyPrototypeBundle } from "./bundle.js";
export { prototypeSha256 } from "./digest.js";
export {
  resolvePrototypeJsonPointer,
  type PrototypeResolvedJsonPointer,
} from "./json-pointer.js";
export {
  resolvePrototypeTextLocator,
  type PrototypeResolvedTextLocator,
  type PrototypeTextLocator,
  type PrototypeTextOffsetBasis,
} from "./text-locator.js";
