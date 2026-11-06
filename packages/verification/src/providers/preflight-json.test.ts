import { describe, expect, it } from "vitest";
import { preflightJson } from "./http.js";
import { ProviderFailure } from "./port.js";

const limits = {
  maximumNodes: 100,
  maximumDepth: 4,
  maximumCollection: 8,
  maximumStringBytes: 64,
};

function failureCode(value: unknown): string | undefined {
  try {
    preflightJson(value, limits);
    return undefined;
  } catch (error) {
    if (error instanceof ProviderFailure) return error.code;
    throw error;
  }
}

function nestedArrays(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe("provider JSON preflight failure precedence", () => {
  it("accepts a value inside every bound", () => {
    expect(failureCode({ a: [1, "two", null, true] })).toBeUndefined();
  });

  it("reports a cyclic graph as PROVIDER_RESPONSE_INVALID", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(failureCode(cyclic)).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports an aliased subtree as PROVIDER_RESPONSE_INVALID", () => {
    const shared = { v: 1 };
    expect(failureCode({ a: shared, b: shared })).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports depth beyond the limit as PROVIDER_RESPONSE_INVALID", () => {
    expect(failureCode(nestedArrays(limits.maximumDepth + 1))).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports node count beyond the limit as PROVIDER_RESPONSE_INVALID", () => {
    const wide = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => [1, 1]));
    expect(failureCode(wide)).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports an aggregate UTF-8 string budget overrun as PROVIDER_RESPONSE_TOO_LARGE", () => {
    expect(failureCode({ text: "é".repeat(40) })).toBe("PROVIDER_RESPONSE_TOO_LARGE");
  });

  it("charges object keys to the same UTF-8 budget", () => {
    const keyed: Record<string, unknown> = {};
    for (let index = 0; index < 8; index += 1) keyed[`ключ-${index}`] = 1;
    expect(failureCode(keyed)).toBe("PROVIDER_RESPONSE_TOO_LARGE");
  });

  it("reports an oversized array as PROVIDER_RESPONSE_INVALID", () => {
    expect(failureCode(Array.from({ length: 9 }, () => 1))).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("checks object entry count before charging its keys", () => {
    const keyed: Record<string, unknown> = {};
    for (let index = 0; index < 9; index += 1) keyed[`ключ-${index}`] = 1;
    expect(failureCode(keyed)).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports a non-finite number as PROVIDER_RESPONSE_INVALID", () => {
    expect(failureCode({ n: Number.NaN })).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("reports an undefined value as PROVIDER_RESPONSE_INVALID", () => {
    expect(failureCode({ u: undefined })).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("walks non-plain objects instead of rejecting them", () => {
    expect(failureCode({ when: new Date(0) })).toBeUndefined();
  });

  it("lets the string budget win when it trips before the depth bound is reached", () => {
    const value = { deep: nestedArrays(10), text: "x".repeat(65) };
    expect(failureCode(value)).toBe("PROVIDER_RESPONSE_TOO_LARGE");
  });
});
