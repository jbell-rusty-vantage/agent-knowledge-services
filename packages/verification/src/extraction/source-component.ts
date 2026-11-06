import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { isPlainRecord } from "../internal/guards.js";
import type { ExtractionFieldRule } from "./field-rules.js";

/** Shared scalar selection; malformed declared components never fall back to raw bytes. */
export function sourceComponentValue(
  rule: ExtractionFieldRule,
  selector: VerificationSelector,
  selectedValue: unknown,
): { value?: string; detail?: string } {
  if (!rule.sourceComponent) return {};
  if (rule.sourceComponent === "table_cell_value") {
    if (selector.kind !== "table" || !isPlainRecord(selectedValue) || typeof selectedValue.value !== "string")
      return {
        detail: "table_cell_value requires a table selector whose resolved source cell has a string value.",
      };
    return { value: selectedValue.value };
  }
  const expectedKind = rule.sourceComponent === "geometry_token_text" ? "bounding_box" : "media_timecode";
  if (
    selector.kind !== expectedKind ||
    (rule.sourceJoiner !== "space" && rule.sourceJoiner !== "none") ||
    !isPlainRecord(selectedValue)
  )
    return {
      detail: `${rule.sourceComponent} requires its matching selector and explicit sourceJoiner.`,
    };
  const items = rule.sourceComponent === "geometry_token_text" ? selectedValue.tokens : selectedValue.segments;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.some((item) => !isPlainRecord(item) || typeof item.text !== "string")
  )
    return {
      detail: `${rule.sourceComponent} requires ordered source tokens/segments with text.`,
    };
  return {
    value: items.map((item) => (item as Record<string, string>).text).join(rule.sourceJoiner === "space" ? " " : ""),
  };
}
