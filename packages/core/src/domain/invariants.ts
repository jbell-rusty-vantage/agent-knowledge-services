import type { DocumentRepresentation, StoreClass } from "@aiengineer/knowledge-contracts";
import { DomainInvariantError } from "./errors.js";

export function assertSourceNativeIntegrity(representation: DocumentRepresentation): void {
  if (
    representation.representationClass === "source_native" &&
    (!representation.sourceNativeByteIdentity || representation.fidelity !== "byte_identical")
  )
    throw new DomainInvariantError(
      "SOURCE_NATIVE_INTEGRITY",
      "Source-native content must be byte-identical to the capture",
    );
}
export function assertAuthorityCompatible(
  source: StoreClass,
  target: StoreClass,
  hasOfficialPromotionDecision: boolean,
): void {
  if (target === "official_canonical" && source !== "official_canonical" && !hasOfficialPromotionDecision)
    throw new DomainInvariantError(
      "AUTHORITY_ESCALATION",
      "Exploratory or user-managed content requires a new official promotion decision",
    );
}
export function assertAppendOnly(previousDigest: string, proposedDigest: string): void {
  if (previousDigest !== proposedDigest)
    throw new DomainInvariantError(
      "IMMUTABLE_RESOURCE",
      "Immutable resources cannot be modified; create a superseding resource",
    );
}
