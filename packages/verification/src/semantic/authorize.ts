import type { Assertion, DeterministicVerificationResult, VerificationBundle } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "../canonical/index.js";
import { deepFreeze } from "../internal/deep-freeze.js";
import { SEMANTIC_RUBRIC_VERSION } from "../versions.js";
import type { SemanticJudgeInput } from "./ports.js";

export const MAX_FRAGMENTS = 16;
export const MAX_FRAGMENT_CHARS = 16_000;
export const MAX_TOTAL_CHARS = 64_000;

export interface MechanicallySelectedFragment {
  readonly evidenceId: string;
  readonly fragmentId: string;
  readonly exactText: string;
  readonly selectedContentDigest: `sha256:${string}`;
}

export interface AuthorizedSemanticFragment extends MechanicallySelectedFragment {
  readonly role: "supports" | "contradicts" | "qualifies" | "context";
  readonly origin: "declared" | "verifier_found";
}

/**
 * A case a judge may see. Only `authorizeSemanticCase` can create one: the
 * brand cannot be forged structurally and runtime identity is tracked in a
 * WeakSet, so a deserialized or hand-built object is rejected downstream.
 */
export interface AuthorizedSemanticCase {
  readonly [authorizedSemanticCaseBrand]: true;
  readonly assertionId: string;
  readonly proposition: string;
  readonly value?: Assertion["value"];
  readonly qualifiers: readonly string[];
  readonly entityBindings: readonly {
    readonly role: string;
    readonly canonicalId: string;
  }[];
  readonly riskClass: Assertion["riskClass"];
  readonly downstreamUse: readonly string[];
  readonly fragments: readonly AuthorizedSemanticFragment[];
}

const authorizedSemanticCaseBrand: unique symbol = Symbol("authorized-semantic-case");
const authorizedSemanticCases = new WeakSet<object>();

/** True only for objects created by `authorizeSemanticCase` in this runtime. */
export function isRuntimeAuthorizedSemanticCase(value: object): boolean {
  return authorizedSemanticCases.has(value);
}

export interface SemanticCaseAuthorizationInput {
  readonly bundle: VerificationBundle;
  readonly deterministicResult: DeterministicVerificationResult;
  readonly assertionId: string;
  readonly selectedFragments: readonly MechanicallySelectedFragment[];
}

/**
 * Evidence-closed authorization. The deterministic gate must be fully open for
 * the bundle and the assertion, and every fragment must be one the engine
 * mechanically selected: declared on the assertion, resolved, and hashing to
 * the digest the engine recorded. Anything else throws; nothing is repaired.
 */
export function authorizeSemanticCase(input: SemanticCaseAuthorizationInput): AuthorizedSemanticCase {
  const { bundle, deterministicResult, assertionId, selectedFragments } = input;
  const assertion = bundle.assertions.find((item) => item.assertionId === assertionId);
  const mechanical = deterministicResult.assertions.find((item) => item.assertionId === assertionId);
  if (!assertion || !mechanical) throw new Error("SEMANTIC_ASSERTION_NOT_FOUND");
  if (
    !mechanical.semanticEligibility ||
    mechanical.status !== "passed" ||
    deterministicResult.status !== "passed" ||
    !deterministicResult.semanticEligibility
  )
    throw new Error("SEMANTIC_MECHANICAL_GATE_CLOSED");
  if (!assertion.atomic || !assertion.proposition) throw new Error("SEMANTIC_ATOMIC_PROPOSITION_REQUIRED");
  if (selectedFragments.length === 0 || selectedFragments.length > MAX_FRAGMENTS)
    throw new Error("SEMANTIC_FRAGMENT_COUNT_INVALID");
  const fragments = authorizeFragments(assertion, mechanical, selectedFragments);
  const admitted = Object.freeze({
    [authorizedSemanticCaseBrand]: true as const,
    assertionId,
    proposition: assertion.proposition,
    ...(assertion.value !== undefined ? { value: deepFreeze(structuredClone(assertion.value)) } : {}),
    qualifiers: Object.freeze([...assertion.qualifiers]),
    entityBindings: Object.freeze(assertion.entityBindings.map((binding) => Object.freeze({ ...binding }))),
    riskClass: assertion.riskClass,
    downstreamUse: Object.freeze([...assertion.downstreamUse]),
    fragments: Object.freeze(fragments),
  });
  authorizedSemanticCases.add(admitted);
  return admitted;
}

type MechanicalAssertion = DeterministicVerificationResult["assertions"][number];

function authorizeFragments(
  assertion: Assertion,
  mechanical: MechanicalAssertion,
  selected: readonly MechanicallySelectedFragment[],
): AuthorizedSemanticFragment[] {
  const ids = new Set<string>();
  let totalCharacters = 0;
  const fragments = selected.map((candidate) => {
    if (ids.has(candidate.fragmentId)) throw new Error("SEMANTIC_FRAGMENT_DUPLICATE");
    ids.add(candidate.fragmentId);
    if (candidate.exactText.length === 0 || candidate.exactText.length > MAX_FRAGMENT_CHARS)
      throw new Error("SEMANTIC_FRAGMENT_SIZE_INVALID");
    totalCharacters += candidate.exactText.length;
    return authorizeFragment(assertion, mechanical, candidate);
  });
  if (totalCharacters > MAX_TOTAL_CHARS) throw new Error("SEMANTIC_TOTAL_EVIDENCE_TOO_LARGE");
  return fragments;
}

/** The fragment must be declared on the assertion, mechanically resolved, and hash to the engine's recorded digest. */
function authorizeFragment(
  assertion: Assertion,
  mechanical: MechanicalAssertion,
  candidate: MechanicallySelectedFragment,
): AuthorizedSemanticFragment {
  const edge = assertion.evidence.find(
    (item) => item.evidenceId === candidate.evidenceId && item.fragment.fragmentId === candidate.fragmentId,
  );
  const mechanicalEvidence = mechanical.evidence.find((item) => item.evidenceId === candidate.evidenceId);
  if (!edge || !mechanicalEvidence) throw new Error("SEMANTIC_FRAGMENT_NOT_DECLARED");
  if (mechanicalEvidence.status !== "passed" || mechanicalEvidence.resolution.status !== "resolved")
    throw new Error("SEMANTIC_FRAGMENT_NOT_MECHANICALLY_SELECTED");
  if (
    mechanicalEvidence.resolution.selectedContentDigest !== candidate.selectedContentDigest ||
    sha256Digest(candidate.exactText) !== candidate.selectedContentDigest
  )
    throw new Error("SEMANTIC_FRAGMENT_DIGEST_MISMATCH");
  return Object.freeze({ ...candidate, role: edge.role, origin: edge.origin });
}

/** Shared live/replay envelope: normalized values cannot be excluded from the reviewed bytes. */
/**
 * Fresh, owned copies: the returned envelope is what gets blinded and
 * retained, so callers may extend it (inferred mutable shape is intentional).
 */
export function semanticJudgeInput(semanticCase: AuthorizedSemanticCase) {
  if (!authorizedSemanticCases.has(semanticCase)) throw new Error("SEMANTIC_CASE_NOT_AUTHORIZED");
  return {
    rubricVersion: SEMANTIC_RUBRIC_VERSION,
    assertionId: semanticCase.assertionId,
    proposition: semanticCase.proposition,
    ...(semanticCase.value !== undefined ? { value: structuredClone(semanticCase.value) } : {}),
    qualifiers: [...semanticCase.qualifiers],
    entityBindings: semanticCase.entityBindings.map((binding) => ({
      ...binding,
    })),
    fragments: semanticCase.fragments.map(({ fragmentId, exactText }) => ({
      fragmentId,
      exactText,
    })),
  };
}
