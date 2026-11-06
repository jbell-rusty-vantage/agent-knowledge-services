import { VectorSpaceSchema, type VectorSpace } from "@aiengineer/knowledge-contracts";

// Derived, not hand-copied (P2-9): the eight spaces this package admits are exactly
// the contract's VectorSpaceSchema options, in the same order, so a ninth space
// added to the contract cannot silently miss admission here.
export const ALL_SPACES: readonly VectorSpace[] = VectorSpaceSchema.options;

export function inferSpaces(query: string): VectorSpace[] {
  if (/benchmark|score|metric/.test(query)) return ["benchmark_intelligence"];
  if (/model|llm/.test(query)) return ["model_capabilities", "engineering_claims"];
  if (/code|implement|api|repository/.test(query))
    return ["implementation_examples", "tool_capabilities", "source_native_sections"];
  if (/paper|study/.test(query)) return ["paper_case_study_knowledge", "source_native_sections"];
  if (/who|company|organization/.test(query)) return ["entity_profiles", "engineering_claims"];
  return [...ALL_SPACES];
}

// The one SPACE_NOT_ADMITTED throw every space-scoped request shares, named for
// what it asserts rather than for the plan-building call site it used to live in.
export function assertAdmittedSpaces(spaces: readonly VectorSpace[], admittedSpaces: readonly VectorSpace[]): void {
  const unauthorized = spaces.filter((x) => !admittedSpaces.includes(x));
  if (unauthorized.length) throw new Error(`SPACE_NOT_ADMITTED:${unauthorized.join(",")}`);
}
