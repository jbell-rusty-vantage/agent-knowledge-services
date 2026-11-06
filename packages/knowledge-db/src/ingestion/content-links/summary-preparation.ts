import {
  ContentLinkOperationSchema,
  JsonValueSchema,
  type ContentLinkOperation,
} from "@aiengineer/knowledge-contracts";
import { canonicalJson, type ArtifactLedger, type ArtifactRecord } from "../../db-read/index.js";
import { canonicalJson as exactCanonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import type { ContentAdmission, KnowledgeSqlClient, KnowledgeTransactions } from "../../ports.js";
import { isOfficiallyAdmittedVerdict } from "../evidence-admission.js";
import { ContentSourceReader } from "./sources.js";
import { contentLinkEffect } from "./operations.js";
import type { AuthenticatedContentEvidence, ContentLinkAuthority } from "./types.js";

type SummaryOperation = Extract<ContentLinkOperation, { kind: "summary.materialize" }>;
interface SummaryPreparationConfig {
  readonly db: KnowledgeTransactions;
  readonly admission: ContentAdmission;
  readonly artifacts: ArtifactLedger;
  readonly authority: ContentLinkAuthority;
  readonly tenantId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
}
export interface ContentSummaryPreparationResult {
  readonly transformationRunId: string;
  readonly representationId: string;
  readonly outputArtifact: ArtifactRecord;
  readonly receiptArtifact: ArtifactRecord;
  readonly acceptanceState: string;
}

/** Produces a pending representation from exact admitted text, independently of graph summary admission. */
export class ContentSummaryPreparer {
  constructor(private readonly config: SummaryPreparationConfig) {}

  async prepare(raw: unknown): Promise<ContentSummaryPreparationResult> {
    const operation = ContentLinkOperationSchema.parse(JsonValueSchema.parse(raw));
    if (operation.kind !== "summary.materialize") throw new Error("CONTENT_SUMMARY_OPERATION_REQUIRED");
    return this.config.db.transaction(
      {
        tenantId: this.config.tenantId,
        role: "executor_service",
        isolationLevel: "repeatable read",
        statementTimeoutMs: 120000,
      },
      async (client) => {
        const sources = new ContentSourceReader({
          client,
          tenantId: this.config.tenantId,
          artifacts: this.config.artifacts,
          admission: this.config.admission,
        });
        const evidence: AuthenticatedContentEvidence[] = [];
        for (const reference of operation.evidence)
          evidence.push(
            await this.config.authority.authenticate({
              client,
              tenantId: this.config.tenantId,
              policyDigest: this.config.policyDigest,
              reference,
            }),
          );
        const text = admittedText(operation, evidence, this.config.policyDigest);
        await sources.documentVersion(operation.documentVersion);
        const input = await sources.representation(operation.derivedFrom, operation.documentVersion.id);
        if (
          !["source_native", "faithful_normalization", "structural_extraction"].includes(
            String(input.representation_class),
          )
        )
          throw new Error("CONTENT_SUMMARY_FAITHFUL_INPUT_REQUIRED");
        await this.verifySources(sources, operation, evidence, String(input.artifact_id));
        const outputArtifact = await this.config.artifacts.putWith(client, {
          tenantId: this.config.tenantId,
          missionId: this.config.missionId,
          artifactType: "content_summary_text",
          text,
          mediaType: "text/plain; charset=utf-8",
        });
        if (outputArtifact.storageState !== "available" || outputArtifact.digest !== operation.representation.digest)
          throw new Error("CONTENT_SUMMARY_OUTPUT_CUSTODY_REQUIRED");
        const requestDigest = sha256Digest(
          JsonValueSchema.parse({
            operation,
            policyDigest: this.config.policyDigest,
            attemptId: this.config.attemptId,
          }),
        );
        const receiptArtifact = await this.config.artifacts.putWith(client, {
          tenantId: this.config.tenantId,
          missionId: this.config.missionId,
          artifactType: "content_summary_preparation_receipt",
          mediaType: "application/json",
          text: exactCanonicalJson(
            JsonValueSchema.parse({
              schemaVersion: "content-summary-preparation.v1",
              renderingVersion: "content-summary-literal.v1",
              tenantId: this.config.tenantId,
              missionId: this.config.missionId,
              attemptId: this.config.attemptId,
              policyDigest: this.config.policyDigest,
              requestDigest,
              operation,
              inputArtifact: { id: input.artifact_id, digest: operation.derivedFrom.digest },
              outputArtifact: {
                id: outputArtifact.artifactId,
                digest: outputArtifact.digest,
                mediaType: outputArtifact.mediaType,
                sizeBytes: outputArtifact.sizeBytes,
              },
              admittedClaims: evidence.map((item) => ({
                reference: item.reference,
                statement: item.statement,
                qualifiers: item.qualifiers,
                selectedText: item.selectedText,
                selectedContentDigest: item.selectedContentDigest,
                representationArtifactId: item.representationArtifactId,
              })),
            }),
          ),
        });
        await this.config.admission.persistPreparedSummary(client, {
          tenantId: this.config.tenantId,
          missionId: this.config.missionId,
          attemptId: this.config.attemptId,
          transformationRunId: operation.transformationRunId,
          representationId: operation.representation.id,
          documentVersionId: operation.documentVersion.id,
          inputRepresentationId: operation.derivedFrom.id,
          inputArtifact: { id: String(input.artifact_id), digest: operation.derivedFrom.digest },
          outputArtifact: { id: outputArtifact.artifactId, digest: outputArtifact.digest },
          receiptArtifact: { id: receiptArtifact.artifactId, digest: receiptArtifact.digest },
          requestDigest,
          ...(operation.language ? { language: operation.language } : {}),
        });
        await this.linkReceipt(client, receiptArtifact, outputArtifact, String(input.artifact_id), evidence);
        const row = (
          await client.query<{ acceptance_state: string }>(
            "select acceptance_state from content.document_representation where tenant_id=$1 and id=$2",
            [this.config.tenantId, operation.representation.id],
          )
        ).rows[0];
        if (!row) throw new Error("CONTENT_SUMMARY_OUTPUT_MISSING");
        const admission = await this.config.admission.readRepresentationAdmission(client, {
          tenantId: this.config.tenantId,
          representationId: operation.representation.id,
          guardedDigest: operation.representation.digest,
        });
        return {
          transformationRunId: operation.transformationRunId,
          representationId: operation.representation.id,
          outputArtifact,
          receiptArtifact,
          acceptanceState: admission.accepted
            ? "accepted"
            : admission.decision === "accept"
              ? "unaccepted"
              : (admission.decision ?? "pending"),
        };
      },
    );
  }

  private async verifySources(
    reader: ContentSourceReader,
    operation: SummaryOperation,
    evidence: readonly AuthenticatedContentEvidence[],
    inputArtifactId: string,
  ): Promise<void> {
    const used = new Set<AuthenticatedContentEvidence>();
    for (const source of operation.sources) {
      if (source.representationId !== operation.derivedFrom.id) throw new Error("CONTENT_SUMMARY_SOURCE_MISMATCH");
      const node = await reader.node(source);
      const matching = evidence.filter(
        (item) =>
          node.text.includes(item.selectedText) &&
          (item.representationArtifactId === inputArtifactId ||
            item.representationArtifactId === item.captureArtifactId),
      );
      if (!matching.length) throw new Error("CONTENT_SUMMARY_SELECTED_BYTES_REQUIRED");
      for (const item of matching) {
        await reader.representationCapture(
          operation.derivedFrom,
          operation.documentVersion.id,
          item.reference.captureId,
        );
        used.add(item);
      }
    }
    if (used.size !== evidence.length) throw new Error("CONTENT_SUMMARY_EVIDENCE_CENSUS_MISMATCH");
  }

  private async linkReceipt(
    client: KnowledgeSqlClient,
    receipt: ArtifactRecord,
    output: ArtifactRecord,
    inputId: string,
    evidence: readonly AuthenticatedContentEvidence[],
  ): Promise<void> {
    const parents = new Set([
      output.artifactId,
      inputId,
      ...evidence.flatMap((item) => [
        item.reference.manifest.id,
        item.captureArtifactId,
        item.representationArtifactId,
      ]),
    ]);
    for (const parent of parents) {
      if (
        (await this.config.artifacts.link(client, {
          tenantId: this.config.tenantId,
          from: receipt.artifactId,
          to: parent,
          relation: "derived_from",
        })) !== "written"
      )
        throw new Error("CONTENT_SUMMARY_RECEIPT_LINEAGE_REQUIRED");
    }
  }
}

function admittedText(
  operation: SummaryOperation,
  evidence: readonly AuthenticatedContentEvidence[],
  policyDigest: string,
): string {
  if (
    operation.representation.id === operation.derivedFrom.id ||
    operation.applicability.validFrom !== null ||
    operation.applicability.validTo !== null ||
    new Set(operation.sources.map((source) => source.id)).size !== operation.sources.length ||
    (operation.scope === "section" && !operation.scopeNodeId) ||
    (operation.scope === "entity_view" && !operation.focusEntityId) ||
    (operation.scopeNodeId && !operation.sources.some((source) => source.id === operation.scopeNodeId))
  )
    throw new Error("CONTENT_SUMMARY_SCOPE_INVALID");
  if (
    operation.evidence.length !== evidence.length ||
    operation.evidence.some(
      (reference) => evidence.filter((item) => canonicalJson(item.reference) === canonicalJson(reference)).length !== 1,
    )
  )
    throw new Error("CONTENT_SUMMARY_EVIDENCE_CENSUS_MISMATCH");
  const claims = new Map<string, AuthenticatedContentEvidence>();
  for (const item of evidence) {
    if (
      !operation.evidence.some((reference) => canonicalJson(reference) === canonicalJson(item.reference)) ||
      !item.eligible ||
      item.policyDigest !== policyDigest ||
      !["pass", "pass_with_warnings"].includes(item.policyOutcome) ||
      !isOfficiallyAdmittedVerdict(item.verdict) ||
      !item.downstreamUse.includes("content_link:summary.materialize") ||
      item.value !== contentLinkEffect(operation) ||
      !item.selectedText ||
      sha256Digest(item.selectedText) !== item.selectedContentDigest
    )
      throw new Error("CONTENT_SUMMARY_ADMITTED_EFFECT_REQUIRED");
    const previous = claims.get(item.reference.claimId);
    if (
      previous &&
      (previous.statement !== item.statement || canonicalJson(previous.qualifiers) !== canonicalJson(item.qualifiers))
    )
      throw new Error("CONTENT_SUMMARY_CLAIM_CONFLICT");
    claims.set(item.reference.claimId, item);
  }
  const qualifiers = [...new Set(evidence.flatMap((item) => [...item.qualifiers]))].sort();
  if (canonicalJson([...operation.applicability.qualifiers].sort()) !== canonicalJson(qualifiers))
    throw new Error("CONTENT_SUMMARY_QUALIFIERS_MISMATCH");
  const rendered = [...claims.values()].map((item) => [item.statement, ...item.qualifiers].join("\n")).join("\n\n");
  if (rendered !== operation.text || sha256Digest(rendered) !== operation.representation.digest)
    throw new Error("CONTENT_SUMMARY_RENDERING_MISMATCH");
  return rendered;
}
