import type { AcquisitionRequest, PaperResolution } from "../types.js";

const PREFERRED_REPRESENTATION = ["application/pdf", "text/html", "text/plain"] as const;

export function planPaperAsHttpRequest(
  resolution: PaperResolution,
  requestDefaults: Omit<AcquisitionRequest, "target">,
): AcquisitionRequest {
  const representation = pickRepresentation(resolution.representations);
  if (!representation?.url.startsWith("https:")) throw new Error("PAPER_REPRESENTATION_UNAVAILABLE");
  return {
    ...requestDefaults,
    target: { kind: "http", url: representation.url },
    preferredMediaTypes:
      requestDefaults.preferredMediaTypes.length > 0 ? requestDefaults.preferredMediaTypes : [representation.mediaType],
  };
}

function pickRepresentation(
  representations: PaperResolution["representations"],
): PaperResolution["representations"][number] | undefined {
  for (const mediaType of PREFERRED_REPRESENTATION) {
    const match = representations.find((item) => item.mediaType === mediaType);
    if (match) return match;
  }
  return representations[0];
}
