import type { DiagnosticsCompanyFieldPlan } from "./verification-diagnostics-company-fields.js";

const escape = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Read-only inspection of canonical extraction leaves; it grants no semantic admission. */
export function renderDiagnosticsCompanyFields(plans: readonly DiagnosticsCompanyFieldPlan[]): string {
  const companies = plans
    .map((plan) => {
      const rows = plan.slots
        .flatMap((slot) =>
          slot.leaves.map((leaf) => {
            if (!/^[a-z0-9-]+$/u.test(leaf.caseId)) throw new Error("DIAGNOSTICS_FIELD_VIEW_CASE_ID_INVALID");
            return `<tr><th scope="row">${escape(slot.slot)}</th><td>${escape(leaf.asStated)}</td><td>${escape(typeof leaf.normalized.value === "object" ? JSON.stringify(leaf.normalized.value) : leaf.normalized.value)}${leaf.normalized.qualifier ? ` ${escape(leaf.normalized.qualifier)}` : ""}${leaf.normalized.unit ? ` (${escape(leaf.normalized.unit)})` : ""}</td><td>${escape(leaf.context.product ?? "Product unspecified")}<br>${escape(leaf.context.page ?? "Page unspecified")}<br>Version: ${escape(leaf.context.version ?? "not stated")}<br>Captured: ${escape(leaf.context.capturedAt)}</td><td>${leaf.conflictSetId ? escape(leaf.conflictSetId) : "No conflict set assigned"}</td><td><a href="evidence-appendix.html#fragment-${leaf.caseId}">${escape(leaf.caseId)}</a><details><summary>Exact locator and lineage</summary><pre>${escape(JSON.stringify({ source: leaf.source, lineage: leaf.lineage, derivation: leaf.normalized.derivation }, null, 2))}</pre></details></td></tr>`;
          }),
        )
        .join("");
      const unavailable = plan.slots.filter((slot) => slot.status === "unavailable");
      return `<section><h2>${escape(plan.companyId)}</h2><p>Field plan: <code>${escape(plan.planDigest)}</code></p><div class="table"><table><thead><tr><th>Field</th><th>As stated</th><th>Normalized value</th><th>Context</th><th>Conflict membership</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div><h3>Unavailable fields (${unavailable.length})</h3><p>These fields have no verified leaf in this bounded frozen-source plan. This does not establish that the fact is absent from the company's full website.</p><ul>${unavailable.map((slot) => `<li>${escape(slot.slot)}: ${escape(slot.unavailableReason)}</li>`).join("")}</ul></section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Company field evidence ledger</title><style>body{font:16px system-ui;margin:2rem;line-height:1.5;color:#182433}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:.65rem;border:1px solid #d6dce3}thead{background:#eef2f6}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:35rem}code{overflow-wrap:anywhere}a{color:#0645ad}section{margin-top:2rem}</style></head><body><h1>Company field evidence ledger</h1><p>Literal fields verified against frozen source captures. Mechanical acceptance does not establish independent validation, scientific correctness or human gold. Conflicting source wording remains separate.</p><p><a href="verification-audit.html">Verification audit</a> · <a href="company-fields.json">Machine-readable field results</a> · <a href="evidence-appendix.html">Evidence appendix</a></p>${companies}</body></html>\n`;
}
