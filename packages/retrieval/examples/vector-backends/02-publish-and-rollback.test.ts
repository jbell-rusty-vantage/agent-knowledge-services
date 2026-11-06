import { describe, expect, it } from "vitest";
import { publishAndRollbackExample } from "./02-publish-and-rollback.js";

describe("example 02: publish and rollback", () => {
  it("verifies publish, replays idempotently, and rolls back to an intact predecessor", async () => {
    const result = await publishAndRollbackExample();
    expect(result.idempotentReplay).toBe(true);
    expect(result.eventsRecorded).toBe(3);
    expect(result.predecessorId).toBe("publication-1");
    expect(result.activeAfterRollback).toBe("publication-1");
  });
});
