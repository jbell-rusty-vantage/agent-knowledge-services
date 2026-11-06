/** Synthetic temporal corpus using the same admitted producers as the publication proof. */
import { createSelectedCandidateFixture } from "../../../apps/verification-executor/src/knowledge/selected-candidate-fixture.js";
import {
  evaluateCandidate,
  publicationIdFor,
  publishCandidate,
  PUBLICATION_SPACE,
} from "../../../apps/verification-executor/src/knowledge/selected-candidate-publication.js";

export const retrievalHistoryEvents = [
  {
    key: "announcement",
    statement: "Synthetic Model X API was announced on 2026-01-15.",
    eventKind: "product_announced",
    from: "2026-01-15T00:00:00.000Z",
    to: "2026-01-16T00:00:00.000Z",
  },
  {
    key: "ga",
    statement: "Synthetic Model X API became generally available on 2026-06-10.",
    eventKind: "product_generally_available",
    from: "2026-06-10T00:00:00.000Z",
    to: "2026-06-11T00:00:00.000Z",
  },
];

export async function buildRetrievalHistoryFixture(input) {
  const fixture = await createSelectedCandidateFixture({
    ...input,
    spaces: [PUBLICATION_SPACE],
    temporalEvents: input.temporalEvents ?? retrievalHistoryEvents,
  });
  try {
    const evaluation = await evaluateCandidate(fixture, fixture);
    const operationId = await publishCandidate(fixture, {
      ...evaluation,
      candidateInput: fixture.candidateInput,
      candidate: fixture.candidate,
      steps: 2,
      reason: "Activate independently evaluated announcement and GA temporal claims",
    });
    const publicationId = await publicationIdFor(fixture, operationId, "verify.succeeded");
    return { ...fixture, publicationId, evaluation };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
