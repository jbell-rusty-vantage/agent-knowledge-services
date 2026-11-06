/** Closed server-owned execution hosts. No arbitrary operation/step tuple is accepted. */
export type VerificationProviderHost = "structured_extraction" | "claims" | "report";

export function verificationProviderHostTuple(host: VerificationProviderHost = "structured_extraction") {
  switch (host) {
    case "structured_extraction":
      return { operationKind: "verification_structured_extraction", stepKey: "extract_and_register" } as const;
    case "claims":
      return { operationKind: "verification_claims", stepKey: "verify_claims_and_register" } as const;
    case "report":
      return { operationKind: "verification_report", stepKey: "verify_report_and_register" } as const;
    default:
      throw new Error("VERIFICATION_PROVIDER_HOST_INVALID");
  }
}
