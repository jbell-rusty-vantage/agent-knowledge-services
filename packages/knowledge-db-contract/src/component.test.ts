import { describe, expect, it } from "vitest";
import { loadComponent } from "./component.js";

describe("knowledge_verification component", () => {
  it("loads eight ordered migrations with stable digests and no self-managed transactions", () => {
    const component = loadComponent();
    expect(component.migrations.map((m) => m.key)).toEqual([
      "0001_verification_foundation",
      "0002_observations_reports_and_custody",
      "0003_admission_revocation_and_outbox",
      "0004_operations",
      "0005_signatures_review_and_outbox",
      "0006_credential_use_and_protocol_receipts",
      "0007_server_clock_and_required_values_digest",
      "0008_effect_dispatch_journal",
    ]);
    expect(component.manifest.component_version).toBe("2.5.0");
    expect(component.manifest.component_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loadComponent().manifest.component_digest).toBe(component.manifest.component_digest);
    for (const migration of component.migrations) {
      expect(migration.sql).not.toMatch(/\r\n/);
      expect(migration.sql).toMatch(/knowledge_verification/);
      expect(migration.sql).not.toMatch(/grant .* to public/i);
      expect(migration.sql).not.toMatch(/\bto (authenticated|anon|service_role)\b/);
    }
  });
});
