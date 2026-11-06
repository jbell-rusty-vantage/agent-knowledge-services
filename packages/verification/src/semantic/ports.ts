import type { Assertion, SemanticJudgeIdentity } from "@aiengineer/knowledge-contracts";
import type { SEMANTIC_RUBRIC_VERSION } from "../versions.js";

/** Cancellation and deadline for one judge invocation. */
export interface SemanticJudgeExecution {
  readonly signal?: AbortSignal;
  readonly deadlineEpochMs?: number;
}

/** The blinded envelope a judge receives: the proposition and its authorized fragments, nothing about the source or verdict so far. */
export interface SemanticJudgeInput {
  readonly rubricVersion: typeof SEMANTIC_RUBRIC_VERSION;
  /** Digest of the blinded, authorized input envelope. */
  readonly inputArtifactDigest?: `sha256:${string}`;
  readonly assertionId: string;
  readonly proposition: string;
  readonly value?: Assertion["value"];
  readonly qualifiers: readonly string[];
  readonly entityBindings: readonly {
    readonly role: string;
    readonly canonicalId: string;
  }[];
  readonly fragments: readonly {
    readonly fragmentId: string;
    readonly exactText: string;
  }[];
}

export interface SemanticJudgeAdapter {
  /** Supplied by trusted deployment composition, never accepted from provider output. */
  readonly identity: SemanticJudgeIdentity;
  readonly maximumInputCharacters: number;
  /** A judge is deliberately composed with no external capabilities. */
  readonly toolCatalog?: readonly [];
  judge(input: SemanticJudgeInput, execution: SemanticJudgeExecution): Promise<unknown>;
}

export type SemanticJudgePort = SemanticJudgeAdapter;
