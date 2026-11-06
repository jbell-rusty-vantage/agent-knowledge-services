import type {
  SelectedCandidateFixture,
  SelectedCandidateFixtureOptions,
} from "../../../apps/verification-executor/src/knowledge/selected-candidate-fixture.js";

export const retrievalHistoryEvents: NonNullable<SelectedCandidateFixtureOptions["temporalEvents"]>;
export function buildRetrievalHistoryFixture(
  input: Pick<
    SelectedCandidateFixtureOptions,
    "databaseUrl" | "storage" | "temporalEvents" | "derivedSummaryStatements"
  >,
): Promise<SelectedCandidateFixture & { publicationId: string }>;
