import { z } from "zod";

/** Input of the `source_discovery` operation: rank and deduplicate candidate URLs the caller already found. */
export const SourceDiscoveryInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.source-discovery/v1"),
  query: z.string().trim().min(1).max(2_000),
  candidates: z
    .array(
      z.strictObject({
        url: z.url().max(4_096),
        title: z.string().trim().min(1).max(500),
        sourceClass: z.string().trim().min(1).max(100),
        publisher: z.string().trim().min(1).max(300).optional(),
        score: z.number().finite().min(0).max(1),
        evidence: z.array(z.string().trim().min(1).max(1_000)).max(16),
      }),
    )
    .max(500),
  limit: z.int().positive().max(100).default(25),
});

/** Input of the `source_resolution` operation: canonical identifiers for URL, DOI, arXiv and OpenReview candidates. */
export const SourceResolutionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.source-resolution/v1"),
  candidates: z
    .array(
      z.strictObject({
        candidateId: z.string().trim().min(1).max(255),
        identifierKind: z.enum(["url", "doi", "arxiv", "openreview"]),
        identifier: z.string().trim().min(1).max(4_096),
      }),
    )
    .min(1)
    .max(500),
});

/** Input of the `capture` operation: fetch one HTTP target or a staged upload and seal its bytes. */
export const CaptureInputSchema = z
  .strictObject({
    schemaVersion: z.literal("knowledge.capture/v1"),
    source: z.strictObject({
      sourceClass: z.enum(["web_page", "api", "repository", "pdf", "transcript", "dataset", "registry", "other"]),
      canonicalUrl: z.url(),
      publisher: z.string().trim().min(1).optional(),
      sensitivity: z.enum(["public", "restricted", "confidential"]),
    }),
    request: z.strictObject({
      purpose: z.string().trim().min(1),
      target: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("http"), url: z.url() }),
        z.strictObject({
          kind: z.literal("upload"),
          uploadId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
          declaredOrigin: z.string().trim().min(1),
        }),
      ]),
      expectedSourceClass: z.string().trim().min(1),
      preferredMediaTypes: z.array(z.string().trim().min(1)).min(1),
      egressProfile: z.literal("public-web-v1"),
      maximumBytes: z.int().positive().max(1_073_741_824),
      renderingPolicy: z.enum(["none", "allowed", "required"]),
      interactionPolicy: z.enum(["none", "bounded"]),
      classification: z.enum(["public", "restricted", "confidential"]),
      expectedOutputs: z.array(z.string().trim().min(1)).min(1),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.request.target.kind === "http" &&
      new URL(value.source.canonicalUrl).href !== new URL(value.request.target.url).href
    ) {
      context.addIssue({
        code: "custom",
        message: "source canonical URL must equal the exact capture target",
        path: ["source", "canonicalUrl"],
      });
    }
    if (value.source.sensitivity !== value.request.classification) {
      context.addIssue({
        code: "custom",
        message: "source sensitivity must equal capture classification",
        path: ["source", "sensitivity"],
      });
    }
  });

const VettedDocumentSchema = z.strictObject({
  id: z.string().trim().min(1),
  document_kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  canonical_url: z.string(),
  source_role: z.enum(["official", "primary", "authoritative_secondary"]),
  publisher: z.string().trim().min(1),
  source_class: z.string().trim().min(1),
  target_vector_spaces: z.array(z.string()),
  text: z.string(),
  entity_slugs: z.array(z.string()),
});

const VettedClaimSchema = z.strictObject({
  id: z.string().trim().min(1),
  statement: z.string().trim().min(1),
  claim_role: z.string().trim().min(1),
  problem: z.string().optional(),
  mechanism: z.string().optional(),
  applicability: z.string().optional(),
  limitations: z.string().optional(),
  attribution: z.string().trim().min(1),
  locator_excerpt: z.string().trim().min(1),
  related_entities: z.array(z.string().trim().min(1)),
});

/** Input of the `source_vetting` operation: one embedding bundle of selected documents and their claims. */
export const SourceVettingInputSchema = z.strictObject({
  schema_version: z.literal("ai-engineer-embedding-bundle/0.1.0"),
  store_class: z.literal("internal_exploratory"),
  video_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  research_as_of: z.iso.date(),
  primary: z.strictObject({
    engineer: z.strictObject({ slug: z.string().trim().min(1), display_name: z.string().trim().min(1) }),
    organization: z.strictObject({ slug: z.string().trim().min(1), display_name: z.string().trim().min(1) }),
  }),
  selected_documents: z.array(VettedDocumentSchema).min(1),
  engineering_claims: z.array(VettedClaimSchema),
});
