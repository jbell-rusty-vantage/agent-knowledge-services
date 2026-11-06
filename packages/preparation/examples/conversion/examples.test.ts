import { describe, expect, it } from "vitest";
import { runTextConvertExample } from "./01-text-convert.js";
import { runPdfDoclingExample } from "./02-pdf-docling.js";
import { runInspectFidelityExample } from "./03-inspect-fidelity.js";
import { runDoclingThenUnstructuredExample } from "./04-docling-then-unstructured.js";
import { runImportStoredMarkdownExample } from "./05-import-stored-markdown.js";
import { runManagedDeniedExample } from "./06-managed-denied.js";

describe("conversion examples", () => {
  it("covers text, Docling, inspect, fallback, import, and managed denial", async () => {
    const text = await runTextConvertExample();
    expect(text.routed.receipt.selectedProviderKey).toBe("deterministic-structural-text");
    expect(text.calls).toEqual([]);
    const pdf = await runPdfDoclingExample();
    expect(pdf.routed.receipt.selectedProviderKey).toBe("docling-serve");
    expect(pdf.calls).toEqual(["docling-serve"]);
    const inspect = await runInspectFidelityExample();
    expect(inspect.output.fidelity.grade).toBe("high");
    const fallback = await runDoclingThenUnstructuredExample();
    expect(fallback.routed.receipt.fallbackUsed).toBe(true);
    expect(JSON.stringify(fallback.routed.receipt)).not.toContain("secret-must-not-escape");
    const imported = await runImportStoredMarkdownExample();
    expect(imported.output.nodes.length).toBeGreaterThan(1);
    const denied = await runManagedDeniedExample();
    expect(denied.unstructuredJobs).toBe(0);
    expect(denied.denied).toBe("MANAGED_PROCESSING_DENIED");
  });
});
