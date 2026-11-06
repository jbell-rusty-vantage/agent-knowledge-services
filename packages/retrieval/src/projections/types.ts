import type { SourceLocator } from "@aiengineer/knowledge-contracts";

export interface EvidenceSupport {
  readonly locatorId: string;
  readonly locator: SourceLocator;
  readonly quotedText: string;
}

export interface SupportedAssertion {
  readonly id: string;
  readonly statement: string;
  readonly supportLocatorIds: readonly string[];
}

interface ProjectionInputBase {
  readonly sourceRecordId: string;
  readonly procedureVersionId: string;
  readonly evidence: readonly EvidenceSupport[];
  readonly assertions: readonly SupportedAssertion[];
}

export type ProjectionInput =
  | (ProjectionInputBase & {
      readonly space: "engineering_claims";
      readonly claimClass: string;
      readonly attribution: string;
      readonly problem: string;
      readonly mechanism: string;
      readonly applicability: readonly string[];
      readonly limitations: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "tool_capabilities";
      readonly toolName: string;
      readonly capabilities: readonly string[];
      readonly constraints: readonly string[];
      readonly languages?: readonly string[];
      readonly frameworks?: readonly string[];
      readonly deploymentModes?: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "implementation_examples";
      readonly objective: string;
      readonly language: string;
      readonly framework?: string;
      readonly commit: string;
      readonly path: string;
      readonly symbol?: string;
      readonly dependencies?: readonly string[];
      readonly codeIdentifiers?: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "paper_case_study_knowledge";
      readonly title: string;
      readonly findingClass: string;
      readonly derived: boolean;
      readonly sectionRole: string;
      readonly findings: readonly string[];
      readonly caveats: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "entity_profiles";
      readonly entityType: string;
      readonly canonicalName: string;
      readonly aliases: readonly string[];
      readonly profileKind: "identity" | "capability" | "technical_significance" | "ecosystem";
      readonly identifiers?: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "model_capabilities";
      readonly modelVersion: string;
      readonly capabilities: readonly string[];
      readonly constraints: readonly string[];
      readonly observedAt: string;
      readonly modalities?: readonly string[];
      readonly tasks?: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "benchmark_intelligence";
      readonly benchmarkVersion: string;
      readonly metric: string;
      readonly protocol: string;
      readonly comparabilityWarnings: readonly string[];
      readonly measuredTask: string;
      readonly dataset?: string;
      readonly resultObservations?: readonly string[];
    })
  | (ProjectionInputBase & {
      readonly space: "source_native_sections";
      readonly sectionPath: readonly string[];
      readonly sourceText: string;
    });

export interface EvidenceValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly supportSetDigest: `sha256:${string}`;
}

export type DomainDisposition =
  | "faithful_source_section"
  | "engineering_claim"
  | "tool_capability"
  | "implementation_example"
  | "paper_case_study"
  | "entity_profile"
  | "model_capability"
  | "benchmark_intelligence"
  | "not_ingestible";

export interface ClassificationProposal {
  readonly dispositions: readonly DomainDisposition[];
  readonly targetContractVersion: string;
  readonly deduplicationKeys: readonly string[];
  readonly evidenceLocatorIds: readonly string[];
  readonly unresolvedIdentityQuestions: readonly string[];
}
