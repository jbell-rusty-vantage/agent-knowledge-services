import type { CapabilityAdmission } from "@aiengineer/knowledge-contracts";
import { DomainInvariantError } from "@aiengineer/knowledge-core";

export function requireAdmittedCapability(
  capability: CapabilityAdmission,
  expectedKind: string,
  expectedVersion: string,
): CapabilityAdmission {
  if (capability.lifecycle !== "admitted" || capability.kind !== expectedKind || capability.version !== expectedVersion)
    throw new DomainInvariantError("CAPABILITY_NOT_ADMITTED", "Capability kind/version is not admitted");
  return capability;
}
