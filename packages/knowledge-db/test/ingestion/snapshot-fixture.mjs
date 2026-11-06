/** Persist a real clock preflight for synthetic schema fixtures; never inject a declared digest. */
export async function withSnapshot(reads, intent) {
  const current = await reads.head(intent.context.tenantId);
  const historical =
    intent.expectedKnowledgeHead !== undefined && intent.expectedKnowledgeHead !== current.knowledgeSeq;
  const subject = intent.subjects?.find((subject) => subject.mode === "resolved");
  const snapshot = await reads.runIntent(
    {
      schemaVersion: "knowledge-read-intent.v1",
      intentId: `read-${intent.intentId}`,
      context: intent.context,
      atKnowledgeSeq: intent.expectedKnowledgeHead,
      operations: historical
        ? [
            {
              opId: "historical-control",
              query: "entity.at",
              params: {
                entity_id: subject?.entityId ?? "00000000-0000-7000-8000-000000000099",
                at: "2026-01-01T00:00:00Z",
              },
            },
          ]
        : [{ opId: "head", query: "knowledge.head" }],
    },
    { persist: true },
  );
  return {
    ...intent,
    inputSnapshot: {
      artifactId: snapshot.storage.artifactId,
      snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.snapshotDigest,
      knowledgeSeq: snapshot.atKnowledgeSeq,
    },
  };
}
