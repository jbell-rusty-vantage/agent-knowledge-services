/** Compare retained SQL text and ISO instants without passing fractional seconds through Date. */
export function sameContentInstant(actual: unknown, expected: string | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  const instant = instantNanoseconds(actual);
  return instant !== undefined && instant === instantNanoseconds(expected);
}

function instantNanoseconds(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2})(?::(\d{2}))?)$/.exec(
    value,
  );
  if (!match) return undefined;
  const wholeSecond = `${match[1]}T${match[2]}`;
  const milliseconds = Date.parse(`${wholeSecond}Z`);
  // Reject calendar normalization (e.g. February 30), leap seconds and unsupported offsets.
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== `${wholeSecond}.000Z`)
    return undefined;
  const hours = Number(match[6] ?? 0),
    minutes = Number(match[7] ?? 0);
  if (hours > 23 || minutes > 59) return undefined;
  const offsetSeconds = (hours * 60 + minutes) * 60 * (match[5] === "-" ? -1 : 1);
  return (BigInt(milliseconds) - BigInt(offsetSeconds) * 1000n) * 1_000_000n + BigInt((match[3] ?? "").padEnd(9, "0"));
}
