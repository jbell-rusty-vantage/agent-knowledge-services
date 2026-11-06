import type { AcquisitionObservation } from "../types.js";
import { sealedCaptureDigestMatches } from "./sealed-bytes.js";

export type InspectionFindingStatus = "observed" | "conflict" | "unknown";

export type InspectionDimension =
  | "identity_conflict"
  | "declared_vs_observed_media_type"
  | "redirects"
  | "byte_replay_integrity"
  | "license_rights"
  | "secret_class"
  | "extraction_loss";

export interface InspectionFinding {
  readonly dimension: InspectionDimension;
  readonly status: InspectionFindingStatus;
  readonly note: string;
  readonly offset?: number;
  readonly secretClass?: string;
}

export interface ObserveSealedCaptureInput {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly declaredMediaType?: string;
  readonly acquireObservations?: readonly AcquisitionObservation[];
}

export interface SealedCaptureObservation {
  readonly digest: string;
  readonly findings: readonly InspectionFinding[];
}

const SECRET_CLASS_PATTERNS: readonly { className: string; pattern: RegExp }[] = [
  { className: "bearer_token", pattern: /bearer\s+[a-z0-9._~+/-]+=*/gi },
  { className: "generic_assignment", pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']+["']/gi },
];
const MAXIMUM_SECRET_FINDINGS = 8;

export function observeSealedCapture(input: ObserveSealedCaptureInput): SealedCaptureObservation {
  const observations = input.acquireObservations;
  return {
    digest: input.digest,
    findings: [
      replayIntegrityFinding(input.bytes, input.digest),
      mediaTypeFinding(observations, input.declaredMediaType),
      redirectFinding(observations),
      identityFinding(observations),
      rightsFinding(observations),
      ...secretFindings(input.bytes),
      extractionLossFinding(),
    ],
  };
}

function observationValue(
  observations: readonly AcquisitionObservation[] | undefined,
  key: string,
): string | undefined {
  return observations?.find((item) => item.key === key)?.value;
}

function mediaTypeEssence(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function replayIntegrityFinding(bytes: Uint8Array, digest: string): InspectionFinding {
  const matches = sealedCaptureDigestMatches(bytes, digest);
  return {
    dimension: "byte_replay_integrity",
    status: matches ? "observed" : "conflict",
    note: matches ? "stored digest matches sealed bytes" : "stored digest does not match sealed bytes",
  };
}

function mediaTypeFinding(
  observations: readonly AcquisitionObservation[] | undefined,
  declaredMediaType: string | undefined,
): InspectionFinding {
  const observedMedia = observationValue(observations, "observed_media_type") ?? declaredMediaType;
  const declaredMedia = observationValue(observations, "declared_content_type") ?? declaredMediaType;
  if (!declaredMedia || !observedMedia) {
    return {
      dimension: "declared_vs_observed_media_type",
      status: "unknown",
      note: "no declared or observed media type was supplied",
    };
  }
  const declared = mediaTypeEssence(declaredMedia);
  const observed = mediaTypeEssence(observedMedia);
  const conflict = Boolean(declared && observed && declared !== observed);
  return {
    dimension: "declared_vs_observed_media_type",
    status: conflict ? "conflict" : "observed",
    note: conflict
      ? "declared media type differs from observed media type"
      : "declared and observed media types agree or one is absent",
  };
}

function redirectFinding(observations: readonly AcquisitionObservation[] | undefined): InspectionFinding {
  const redirectsRaw = observationValue(observations, "redirects");
  if (redirectsRaw === undefined) {
    return {
      dimension: "redirects",
      status: "unknown",
      note: "no redirect observation was recorded",
    };
  }
  try {
    const redirects = JSON.parse(redirectsRaw) as unknown;
    const isArray = Array.isArray(redirects);
    return {
      dimension: "redirects",
      status: isArray ? "observed" : "conflict",
      note: isArray ? `${redirects.length} redirect hop(s) recorded` : "redirect observation was not a JSON array",
    };
  } catch {
    return {
      dimension: "redirects",
      status: "conflict",
      note: "redirect observation was not valid JSON",
    };
  }
}

function identityFinding(observations: readonly AcquisitionObservation[] | undefined): InspectionFinding {
  const canonical = observationValue(observations, "final_url");
  return canonical
    ? {
        dimension: "identity_conflict",
        status: "observed",
        note: "final URL recorded; identity conflict is for the caller to judge",
      }
    : {
        dimension: "identity_conflict",
        status: "unknown",
        note: "no final URL observation was recorded",
      };
}

function rightsFinding(observations: readonly AcquisitionObservation[] | undefined): InspectionFinding {
  const rights = observationValue(observations, "rights_context");
  return {
    dimension: "license_rights",
    status: rights ? "observed" : "unknown",
    note: rights ? "rights context observed; this is not acceptance" : "no rights or license observation was recorded",
  };
}

function secretFindings(bytes: Uint8Array): InspectionFinding[] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const findings: InspectionFinding[] = [];
  for (const { className, pattern } of SECRET_CLASS_PATTERNS) {
    pattern.lastIndex = 0;
    for (;;) {
      const match = pattern.exec(text);
      if (match === null || findings.length >= MAXIMUM_SECRET_FINDINGS) break;
      findings.push({
        dimension: "secret_class",
        status: "observed",
        note: "secret-class pattern found; value omitted",
        offset: match.index,
        secretClass: className,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({
      dimension: "secret_class",
      status: "observed",
      note: "no secret-class patterns matched",
    });
  }
  return findings;
}

function extractionLossFinding(): InspectionFinding {
  return {
    dimension: "extraction_loss",
    status: "unknown",
    note: "extraction-loss notes require conversion; inspection of raw bytes cannot admit them",
  };
}
