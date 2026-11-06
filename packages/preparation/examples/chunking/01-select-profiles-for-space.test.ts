import { describe, expect, it } from "vitest";
import { selectProfilesForSpaceExample } from "./01-select-profiles-for-space.js";

describe("example 01: select profiles for a space", () => {
  it("observes the node kinds of the sealed tree", () => {
    expect(selectProfilesForSpaceExample().observedKinds).toEqual(["heading", "paragraph", "list"]);
  });

  it("skips the table profile when the tree has no table", () => {
    const result = selectProfilesForSpaceExample();
    expect(result.admittedForSpace).toEqual(["heading-sections-v1@1.0.0", "table-row-groups-v1@1.0.0"]);
    expect(result.selected).toEqual(["heading-sections-v1@1.0.0"]);
    expect(result.skipped).toEqual(["table-row-groups-v1@1.0.0"]);
  });

  it("selects nothing for a space the tree cannot feed", () => {
    expect(selectProfilesForSpaceExample("implementation_examples").selected).toEqual([]);
  });
});
