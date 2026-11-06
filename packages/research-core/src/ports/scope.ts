import type { Origin } from "@aiengineer/knowledge-operation-protocol";

/**
 * Authenticated scope (K03). Services build it from the host-authenticated invocation (K07) and pass it to every port
 * call; domain code receives it and never constructs, widens or infers it. Caller hints are not authority.
 */
export type AuthScope = Readonly<{
  tenant: string;
  application: string;
  binding: string;
  origin: Origin;
  grants: readonly string[];
}>;
