import { SealKeyRegistryError } from "@aiengineer/knowledge-application";
import { describe, expect, it } from "vitest";
import { toProtocolError } from "./errors.js";

/**
 * OVE-169 W1 D25: an executor whose seal key the installation registry does not pin `active` answers a typed,
 * retryable refusal naming the key id (the key ceremony is a provisioning step), never `INTERNAL`.
 */
describe("seal key registry refusals", () => {
  it("names the unregistered key", () => {
    const error = toProtocolError(new SealKeyRegistryError("SEAL_KEY_UNREGISTERED", "ks-seal-abc"));
    expect(error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(error.details).toEqual({ reason: "seal_key_unregistered", keyId: "ks-seal-abc" });
    expect(error.message).toMatch(/ks-seal-abc is not registered/);
  });

  it("names an inactive key and its status", () => {
    const error = toProtocolError(new SealKeyRegistryError("SEAL_KEY_INACTIVE", "ks-seal-old", "retiring"));
    expect(error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(error.details).toEqual({ reason: "seal_key_inactive", keyId: "ks-seal-old" });
    expect(error.message).toMatch(/ks-seal-old is retiring/);
  });
});
