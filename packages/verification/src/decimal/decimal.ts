export interface DecimalFraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const power10 = (places: number): bigint => 10n ** BigInt(places);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const gcd = (left: bigint, right: bigint): bigint => {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
};
const fraction = (numerator: bigint, denominator: bigint): DecimalFraction => {
  if (denominator === 0n) throw new RangeError("division by zero");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (numerator / divisor) * sign,
    denominator: abs(denominator / divisor),
  };
};

export function parseDecimal(value: string): DecimalFraction {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TypeError(`invalid decimal ${value}`);
  const decimals = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${decimals}`);
  return fraction(match[1] === "-" ? -magnitude : magnitude, power10(decimals.length));
}

const add = (left: DecimalFraction, right: DecimalFraction) =>
  fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
const subtract = (left: DecimalFraction, right: DecimalFraction) =>
  fraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
const multiply = (left: DecimalFraction, right: DecimalFraction) =>
  fraction(left.numerator * right.numerator, left.denominator * right.denominator);
const divide = (left: DecimalFraction, right: DecimalFraction) =>
  fraction(left.numerator * right.denominator, left.denominator * right.numerator);

export function replayDecimalOperation(
  operation: "identity" | "sum" | "difference" | "product" | "ratio" | "percent_change",
  values: readonly string[],
): DecimalFraction {
  if (values.length === 0) throw new RangeError("calculation requires operands");
  const operands = values.map(parseDecimal);
  if (operation === "identity") {
    if (values.length !== 1) throw new RangeError("identity requires exactly one operand");
    return operands[0]!;
  }
  if (operation === "sum") return operands.reduce(add, fraction(0n, 1n));
  if (operation === "difference") return operands.slice(1).reduce(subtract, operands[0]!);
  if (operation === "product") return operands.reduce(multiply, fraction(1n, 1n));
  if (values.length !== 2) throw new RangeError(`${operation} requires exactly two operands`);
  if (operation === "ratio") return divide(operands[0]!, operands[1]!);
  return multiply(divide(subtract(operands[1]!, operands[0]!), operands[0]!), fraction(100n, 1n));
}

export function compareFractions(left: DecimalFraction, right: DecimalFraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function withinTolerance(
  actual: DecimalFraction,
  expected: DecimalFraction,
  tolerance: DecimalFraction,
): boolean {
  const delta = subtract(actual, expected);
  return compareFractions({ numerator: abs(delta.numerator), denominator: delta.denominator }, tolerance) <= 0;
}

export function formatRoundedDecimal(
  value: DecimalFraction,
  places: number,
  mode: "none" | "half_even" | "half_up" | "down",
): string {
  const scale = power10(places);
  const scaledNumerator = value.numerator * scale;
  let quotient = scaledNumerator / value.denominator;
  const remainder = abs(scaledNumerator % value.denominator);
  if (remainder !== 0n && mode === "none")
    throw new RangeError("calculation is not exactly representable at declared precision");
  if (remainder !== 0n && (mode === "half_up" || mode === "half_even")) {
    const twice = remainder * 2n;
    const roundUp =
      twice > value.denominator || (twice === value.denominator && (mode === "half_up" || abs(quotient) % 2n === 1n));
    if (roundUp) quotient += value.numerator < 0n ? -1n : 1n;
  }
  const negative = quotient < 0n;
  const digits = abs(quotient)
    .toString()
    .padStart(places + 1, "0");
  if (places === 0) return `${negative ? "-" : ""}${digits}`;
  return `${negative ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
