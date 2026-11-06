export type PrototypeArithmeticExpression = "identity" | "sum" | "difference" | "product" | "ratio" | "percent_change";

/** Generic arithmetic implementation retained for IEEE-754 legacy result parity. */
export function replayPrototypeArithmetic(
  expression: PrototypeArithmeticExpression,
  operands: readonly number[],
): number {
  if (expression === "identity") return operands[0]!;
  if (expression === "sum") return operands.reduce((total, operand) => total + operand, 0);
  if (expression === "difference")
    return operands.slice(1).reduce((total, operand) => total - operand, operands[0] ?? 0);
  if (expression === "product") return operands.reduce((total, operand) => total * operand, 1);
  if (expression === "ratio")
    return operands.length === 2 && operands[1] !== 0 ? (operands[0] ?? 0) / (operands[1] ?? 1) : Number.NaN;
  return operands.length === 2 && operands[0] !== 0
    ? (((operands[1] ?? 0) - (operands[0] ?? 0)) / (operands[0] ?? 1)) * 100
    : Number.NaN;
}
