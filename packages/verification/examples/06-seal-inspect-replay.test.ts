import { describe, expect, it } from "vitest";
import { sealInspectReplayExample } from "./06-seal-inspect-replay.js";

describe("example 06: seal, inspect, replay", () => {
  it("verifies the detached Ed25519 signature on inspection", async () => {
    const { inspection } = await sealInspectReplayExample();
    expect(inspection).toEqual({
      valid: true,
      signatureStatus: "verified",
      errors: [],
    });
  });

  it("replays to the sealed deterministic result digest", async () => {
    const { replay } = await sealInspectReplayExample();
    expect(replay.matchesSealedDigest).toBe(true);
  });

  it("hands recorded policy inputs to the policy replay port once", async () => {
    const { replay } = await sealInspectReplayExample();
    expect(replay.policyReplays).toBe(1);
    expect(replay.policyOutcome).toBe("pass");
  });

  it("authorizes every artifact before hydrating it", async () => {
    const { replay } = await sealInspectReplayExample();
    const hydrations = replay.custodyCalls.filter((call) => call.startsWith("hydrate:"));
    expect(hydrations.length).toBeGreaterThan(0);
    for (const hydrate of hydrations) {
      const authorize = hydrate.replace("hydrate:", "authorize:");
      expect(replay.custodyCalls.indexOf(authorize)).toBeLessThan(replay.custodyCalls.indexOf(hydrate));
    }
  });
});
