import { z } from "zod";
import { type JsonValue, digestCanonical } from "./canonical.js";
import {
  DigestSchema,
  IdSchema,
  JsonDocumentSchema,
  type Ref,
  type RefKind,
  SafeIntSchema,
  refOf,
  sameRef,
} from "./primitives.js";

/**
 * `readSelected` (Sprint OC WI-02 / OVE-164; Mission Control OUTPUT-CONTRACTS §6): the exact `knowledge.read`.
 *
 * The request (`selected-report-read.v2`, native contract `selected-report-read/v2`, inline) names the exact report
 * revision, the receiver's declared purpose and an exact selection: the whole revision, or named assertion and evidence
 * handles of that revision. The answer is a `research-report-package.v2` manifest holding exactly the selected
 * content, each member under its exact qualified handle. The purpose is recorded with the read; it is not a use
 * decision (current-use eligibility is a separate check) and never widens the selection.
 */
export const KNOWLEDGE_READ_CONTRACT = { name: "selected-report-read", version: "v2" } as const;
export const REPORT_PACKAGE_VERSION = "research-report-package.v2" as const;

/** A declared read purpose (`dependent_input`, `evaluation_subject`, ...): lower snake case, at most 64 characters. */
export const READ_PURPOSE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const ReadPurposeSchema = z
  .string()
  .regex(READ_PURPOSE_PATTERN)
  .describe("The receiver's declared purpose; recorded with the read, never a use decision.");

/** At most this many handles per member kind in one selection. */
export const MAX_SELECTED_HANDLES = 512;

/** Strictly ascending by id: sorted, one handle per id (ids are ASCII, so UTF-16 and code point order agree). */
function ascendingIds(handles: readonly { readonly id: string }[]): boolean {
  return handles.every((handle, index) => index === 0 || (handles[index - 1] as { id: string }).id < handle.id);
}

function selectedHandles<K extends RefKind>(kind: K) {
  return z
    .array(refOf(kind))
    .max(MAX_SELECTED_HANDLES)
    .refine(ascendingIds, { message: "selected handles are sorted by id with one handle per id" })
    .describe(`Exact ${kind} handles of the revision, sorted by id, one per id.`);
}

/**
 * `revision`: the whole exact revision (body, ledger, every assertion and every evidence fragment it names).
 * `members`: only the named assertion and evidence handles (no body, no ledger); at least one handle.
 */
export const ReadSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("revision") }),
  z
    .strictObject({
      mode: z.literal("members"),
      assertions: selectedHandles("assertion"),
      evidence: selectedHandles("fragment"),
    })
    .refine((selection) => selection.assertions.length + selection.evidence.length > 0, {
      path: ["assertions"],
      message: "a members selection names at least one handle",
    }),
]);
export type ReadSelection = z.infer<typeof ReadSelectionSchema>;

/** `selected-report-read.v2`: the inline payload of `knowledge.read`. */
export const SelectedReportReadSchema = z.strictObject({
  report: refOf("report"),
  exact: z.literal(true),
  purpose: ReadPurposeSchema,
  selection: ReadSelectionSchema,
});
export type SelectedReportRead = z.infer<typeof SelectedReportReadSchema>;

/** The digest the package manifest's `request` repeats: the canonical bytes of the exact selected read. */
export function selectedReadDigest(read: SelectedReportRead): string {
  return digestCanonical(read as unknown as JsonValue);
}

/** A custody part of the package (body or ledger): exact artifact handle, digest and byte length. */
export const PackagePartSchema = z
  .strictObject({
    path: z.enum(["body.md", "ledger.json"]),
    digest: DigestSchema,
    bytes: SafeIntSchema,
    artifact: refOf("artifact"),
  })
  .refine((part) => part.digest === part.artifact.digest, {
    path: ["digest"],
    message: "a part's digest is its artifact digest",
  });
export type PackagePart = z.infer<typeof PackagePartSchema>;

function canonicalDigestOf(value: unknown): string | null {
  try {
    return digestCanonical(value as JsonValue);
  } catch {
    return null;
  }
}

function packageMember<K extends RefKind>(kind: K) {
  return z
    .strictObject({ handle: refOf(kind), record: JsonDocumentSchema })
    .refine((member) => canonicalDigestOf(member.record) === member.handle.digest, {
      path: ["record"],
      message: "the record's canonical bytes digest to its handle digest",
    })
    .describe(
      `One selected ${kind}: its exact handle and the immutable record whose kop-canonical-json.v1 digest is the handle digest.`,
    );
}
export const PackageAssertionSchema = packageMember("assertion");
export const PackageEvidenceSchema = packageMember("fragment");

/**
 * `research-report-package.v2`: the frozen manifest a `knowledge.read` names in its terminal `resultRef`. It holds
 * exactly the selection: in `revision` mode the body and ledger parts plus every assertion and evidence member; in
 * `members` mode only the selected members, in selection order, with `body` and `ledger` null.
 */
export const ResearchReportPackageSchema = z
  .strictObject({
    schema: z.literal(REPORT_PACKAGE_VERSION),
    report: refOf("report"),
    revision: IdSchema,
    kind: refOf("report_kind"),
    purpose: ReadPurposeSchema,
    request: DigestSchema.describe("selectedReadDigest of the exact request this package answers."),
    selection: ReadSelectionSchema,
    body: PackagePartSchema.nullable(),
    ledger: PackagePartSchema.nullable(),
    assertions: z.array(PackageAssertionSchema),
    evidence: z.array(PackageEvidenceSchema),
  })
  .superRefine((pkg, context) => {
    const whole = pkg.selection.mode === "revision";
    if (whole !== (pkg.body !== null) || whole !== (pkg.ledger !== null)) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "body and ledger are present exactly for a revision read",
      });
    }
    if (
      !ascendingIds(pkg.assertions.map((member) => member.handle)) ||
      !ascendingIds(pkg.evidence.map((member) => member.handle))
    ) {
      context.addIssue({ code: "custom", path: ["assertions"], message: "members are sorted by id, one per id" });
    }
    if (pkg.selection.mode === "members") {
      const exactly = (members: readonly { readonly handle: Ref }[], selected: readonly Ref[]) =>
        members.length === selected.length &&
        members.every((member, index) => sameRef(member.handle, selected[index] as Ref));
      if (!exactly(pkg.assertions, pkg.selection.assertions) || !exactly(pkg.evidence, pkg.selection.evidence)) {
        context.addIssue({
          code: "custom",
          path: ["selection"],
          message: "a members package holds exactly the selected handles",
        });
      }
    }
  });
export type ResearchReportPackage = z.infer<typeof ResearchReportPackageSchema>;

/**
 * Why a selected read refused, carried as `details.reason` of the K01 error (the code stays one of the K01 codes):
 *  - `purpose_undeclared`        INVALID_ENVELOPE           no (or a malformed) declared purpose;
 *  - `selection_invalid`         INVALID_ENVELOPE           the payload is not an exact `selected-report-read.v2`;
 *  - `report_upstream_mismatch`  INVALID_ENVELOPE           the payload report and the upstream report differ;
 *  - `handle_out_of_scope`       SCOPE_DENIED               a handle names another tenant or binding than the credential;
 *  - `revision_unavailable`      EXACT_REVISION_UNAVAILABLE this binding holds no such exact report revision;
 *  - `member_unknown`            NOT_FOUND                  the revision names no member with that id;
 *  - `member_revision_mismatch`  EXACT_REVISION_UNAVAILABLE the revision names that id under another version or digest;
 *  - `content_integrity`         EXACT_REVISION_UNAVAILABLE stored bytes or records no longer match their handles.
 */
export const READ_REFUSAL_REASONS = [
  "purpose_undeclared",
  "selection_invalid",
  "report_upstream_mismatch",
  "handle_out_of_scope",
  "revision_unavailable",
  "member_unknown",
  "member_revision_mismatch",
  "content_integrity",
] as const;
export type ReadRefusalReason = (typeof READ_REFUSAL_REASONS)[number];
