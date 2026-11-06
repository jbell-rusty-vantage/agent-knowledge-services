// Identity normalization is the only paper symbol a host wires today
// (apps/worker/src/activity-registry.ts); the adapter beside it stays a library.
export function normalizePaperIdentifier(kind: "doi" | "arxiv" | "openreview", value: string): string {
  let normalized = value.trim();
  if (kind === "doi") {
    normalized = normalized
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .toLowerCase();
    if (!/^10\.\d{4,9}\/\S+$/i.test(normalized)) throw new Error("DOI_IDENTITY_INVALID");
  }
  if (kind === "arxiv") {
    normalized = normalized
      .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
      .replace(/\.pdf$/i, "")
      .replace(/^arxiv:\s*/i, "");
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/i.test(normalized))
      throw new Error("ARXIV_IDENTITY_INVALID");
    normalized = normalized.toLowerCase();
  }
  if (kind === "openreview") {
    const urlMatch = normalized.match(/^https?:\/\/openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9_-]+)$/i);
    normalized = urlMatch?.[1] ?? normalized.replace(/^openreview:\s*/i, "");
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(normalized)) throw new Error("OPENREVIEW_IDENTITY_INVALID");
  }
  return normalized;
}
