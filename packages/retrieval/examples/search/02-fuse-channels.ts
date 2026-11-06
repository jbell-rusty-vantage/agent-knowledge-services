import { retrieve } from "../../src/index.js";
import { locator, policy, printJson, records, spaces, tenantId } from "./fixtures.js";

/**
 * Independent channels fuse deterministically: the same query against the same
 * records produces the same evidence-packet digest every time, record r0
 * (identifier match, cosine match, lexical overlap) collects contributions from
 * several channels, and a verified graph edge expands to its neighbor.
 */
export async function fuseChannelsExample() {
  const args = {
    tenantId,
    policy,
    records,
    spaces,
    finalK: 2,
    queryVector: [1, 0],
    hardFilters: [{ field: "language", op: "eq" as const, value: "en" }],
    graphEdges: [
      {
        fromId: "r0",
        toId: "r1",
        kind: "supports",
        verified: true,
        rationale: "recorded support relationship",
        provenance: ["fixture:v1"],
        locatorDigest: locator.quoteDigest,
      },
    ],
    now: "2026-09-01T00:00:00.000Z",
  };
  const first = await retrieve("agent-loop", args);
  const second = await retrieve("agent-loop", args);
  return {
    sameDigestTwice: first.digest === second.digest,
    topRecordId: first.members[0]?.recordId,
    topChannels: first.members[0]?.contributions.map((c) => c.channel),
    graphExpandedToNeighbor: first.members
      .find((m) => m.recordId === "r1")
      ?.contributions.some((c) => c.channel === "graph"),
  };
}

if (process.argv[1]?.includes("02-fuse-channels")) printJson(await fuseChannelsExample());
