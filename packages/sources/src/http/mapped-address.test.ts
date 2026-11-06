import { describe, expect, it } from "vitest";
import { buildPinnedRequestOptions, isForbiddenAddress, resolveSafeHttpTarget, type HttpPolicy } from "./index.js";

const policy: HttpPolicy = {
  allowedProtocols: ["https:"],
  allowedPorts: [443],
  maximumRedirects: 1,
  timeoutMs: 100,
  maximumBytes: 1000,
  maximumDecompressionRatio: 10,
};
const addresses = [
  "0.0.0.1",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.0.1",
  "192.0.0.8",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
];
const hexMapped = (address: string) => {
  const bytes = address.split(".").map(Number);
  return `::ffff:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
};

describe("IPv4-mapped IPv6 acquisition policy parity", () => {
  it.each(addresses)("rejects every spelling of %s before any network request", async (address) => {
    for (const spelling of [address, `::ffff:${address}`, hexMapped(address)]) {
      expect(isForbiddenAddress(spelling)).toBe(true);
      await expect(
        resolveSafeHttpTarget("https://fixture.example/evidence", policy, { resolve: async () => [spelling] }),
      ).rejects.toThrow("ADDRESS_DENIED");
      expect(() => buildPinnedRequestOptions(new URL("https://fixture.example/evidence"), {}, spelling)).toThrow(
        "PINNED_ADDRESS_INVALID",
      );
    }
  });
  it("continues admitting globally routable addresses including their mapped form", async () => {
    for (const address of ["93.184.216.34", "::ffff:93.184.216.34", "::ffff:5db8:d822", "2606:4700:4700::1111"]) {
      expect(isForbiddenAddress(address)).toBe(false);
      await expect(
        resolveSafeHttpTarget("https://fixture.example/evidence", policy, { resolve: async () => [address] }),
      ).resolves.toMatchObject({ addresses: [address] });
    }
  });
});
