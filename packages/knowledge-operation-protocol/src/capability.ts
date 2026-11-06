import { z } from "zod";
import { OperationNameSchema } from "./envelope.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  NameSchema,
  ProtocolVersionSchema,
  SchemaVersionSchema,
} from "./primitives.js";

/**
 * `BindingDescriptor` (design §4): what a binding advertises. Installation alone cannot advertise readiness; every
 * extension needs contract fixtures, a capability declaration and a qualification receipt.
 */
export const QualificationReceiptSchema = z.strictObject({
  capability: NameSchema,
  receiptRef: IdSchema,
  tier: z.enum(["T0", "T1-KS", "T1-MC", "T2-control", "Q"]),
  recordedAt: InstantSchema,
  digest: DigestSchema,
});

export const BindingDescriptorSchema = z.strictObject({
  protocolVersions: z.array(ProtocolVersionSchema).min(1),
  binding: NameSchema,
  application: NameSchema,
  /** Core record schemas the binding stores or validates (`research-core.task.v2`, `research-report.v2`, ...). */
  coreSchemas: z.array(SchemaVersionSchema),
  operations: z.array(OperationNameSchema),
  /**
   * WI-03 S7: what runs the census of `report.assess`: `scripted` (a deterministic double, refused outside a
   * disposable executor), `independent` (an injected auditor) or `none` (`report.assess` refuses).
   */
  auditorKind: z.enum(["scripted", "independent", "none"]),
  reportKinds: z.array(NameSchema),
  media: z.array(NameSchema),
  guarantees: z.strictObject({
    exactRead: z.enum(["exact_revision", "latest_only"]),
    receiptLookup: z.enum(["by_effect_key", "unsupported"]),
    nativeCancellation: z.enum(["native", "stop_dispatch_and_reconcile"]),
    admission: z.enum(["exact_use_decision", "unsupported"]),
    revocation: z.enum(["epoch_checked", "unsupported"]),
    /** The binding's real write guarantee for canonical effects; declared, never inferred. */
    writeAtomicity: z.enum(["single_transaction", "marker_plus_outbox"]),
  }),
  signingIssuer: NameSchema,
  pinnedSchema: z.strictObject({ name: NameSchema, version: SchemaVersionSchema, digest: DigestSchema }),
  qualification: z.array(QualificationReceiptSchema),
  describedAt: InstantSchema,
});
export type BindingDescriptor = z.infer<typeof BindingDescriptorSchema>;

export type CapabilityCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[]; readonly unqualified: readonly string[] };

/** Required unsupported features refuse before execution; declared but unqualified capabilities also refuse. */
export function checkCapabilities(descriptor: BindingDescriptor, required: readonly string[]): CapabilityCheck {
  const advertised = new Set<string>([
    ...descriptor.operations,
    ...descriptor.reportKinds.map((kind) => `report_kind:${kind}`),
    ...descriptor.media.map((media) => `media:${media}`),
    ...Object.entries(descriptor.guarantees).map(([key, value]) => `${key}:${value}`),
  ]);
  const qualified = new Set(descriptor.qualification.map((receipt) => receipt.capability));
  const missing = required.filter((capability) => !advertised.has(capability));
  const unqualified = required.filter((capability) => advertised.has(capability) && !qualified.has(capability));
  return missing.length === 0 && unqualified.length === 0 ? { ok: true } : { ok: false, missing, unqualified };
}
