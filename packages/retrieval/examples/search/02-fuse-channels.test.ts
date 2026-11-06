import { describe, expect, it } from "vitest";
import { fuseChannelsExample } from "./02-fuse-channels.js";

describe("example 02: fuse channels", () => {
  it("produces an identical digest for the same query twice", async () => {
    expect((await fuseChannelsExample()).sameDigestTwice).toBe(true);
  });

  it("ranks the identifier-matching record first", async () => {
    expect((await fuseChannelsExample()).topRecordId).toBe("r0");
  });

  it("collects contributions from exact, trigram and semantic channels for r0", async () => {
    expect((await fuseChannelsExample()).topChannels).toEqual(expect.arrayContaining(["exact", "trigram", "semantic"]));
  });

  it("expands the verified graph edge to r0's neighbor", async () => {
    expect((await fuseChannelsExample()).graphExpandedToNeighbor).toBe(true);
  });
});
