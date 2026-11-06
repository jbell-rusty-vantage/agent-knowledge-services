import type { VerificationBundle, VerificationCheck } from "@aiengineer/knowledge-contracts";
import { isSha256Digest } from "../canonical/index.js";
import type { RuntimePrincipalBinding } from "./bundle-verification.js";
import { CHECK, Checks } from "./checks.js";

/**
 * Whether producer and verifier are provably distinct deployments. The bundle's
 * own declarations are never trusted alone; they must match the runtime
 * principal bindings supplied by the trusted host.
 */
export interface RuntimeSeparation {
  readonly checks: readonly VerificationCheck[];
  /** Bundle producer/verifier deployment ids equal the runtime bindings. */
  readonly bindingMatches: boolean;
  readonly established: boolean;
}

export function establishRuntimeSeparation(
  bundle: VerificationBundle,
  principals: RuntimePrincipalBinding,
): RuntimeSeparation {
  const bindingMatches =
    principals.producerDeploymentId === bundle.producer.deploymentId &&
    principals.verifierDeploymentId === bundle.verifier.deploymentId;
  const digestsWellFormed =
    isSha256Digest(principals.producerPrincipalDigest) && isSha256Digest(principals.verifierPrincipalDigest);
  const principalsDistinct =
    digestsWellFormed && principals.producerPrincipalDigest !== principals.verifierPrincipalDigest;
  const deploymentsDistinct = principals.producerDeploymentId !== principals.verifierDeploymentId;
  const established = bindingMatches && principalsDistinct && deploymentsDistinct;
  const checks = new Checks()
    .require(
      CHECK.RUNTIME_PRINCIPAL_BINDING_MATCH,
      bindingMatches,
      "Bundle deployment declarations must match runtime principal bindings.",
    )
    .require(
      CHECK.RUNTIME_PRINCIPAL_DIGESTS_VALID,
      digestsWellFormed,
      "Runtime principal bindings require canonical SHA-256 digests.",
    )
    .require(CHECK.PRODUCER_VERIFIER_INDEPENDENT, established, {
      pass: "Producer and verifier runtime principals are distinct.",
      fail: "Producer/verifier separation was not established from runtime principal bindings.",
    });
  return { checks: checks.items, bindingMatches, established };
}
