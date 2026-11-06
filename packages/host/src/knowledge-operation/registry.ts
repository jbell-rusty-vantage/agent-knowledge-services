import type { ExternalCustodyReader } from "@aiengineer/knowledge-research-core";
import type { AuditorDiscovery, ReportKindCatalog, SourceAuthorityCatalog } from "@aiengineer/knowledge-application";

import type { SealKeys } from "./backends.js";
import type { BindingConfig } from "./config.js";
import type {
  DeliveryReader,
  EffectLedger,
  KnowledgeApplyPort,
  KnowledgeOperationBackend,
  KnowledgeReadIntentPort,
  ResearchServices,
  RevocationEpochReader,
} from "./ports.js";

/**
 * Knowledge backend registration (Sprint OC R0, ADR-0063 on the Mission Control side; design §§5, 6.2).
 *
 * A binding package exports one `BACKEND: BackendRegistration`; the executor composes a {@link BackendRegistry}
 * from explicit registrations in its `serve.ts`, and `config.ts` resolves each configured `binding` through it. The
 * host keeps only the neutral port types and imports no binding package. A backend's {@link BackendCapability} set
 * replaces the nullable sub-ports, so `describe` and the backend conformance suite state the same facts.
 *
 * R0 (OVE-195) froze these shapes; R5 (OVE-199) moved the factories behind them: `BACKEND` in
 * `@aiengineer/knowledge-binding-aiengineer-postgres` and `@aiengineer/knowledge-binding-biotech-graph`, and the
 * in-memory `BACKEND` in `./in-memory.ts`.
 */

export const BACKEND_CAPABILITIES = [
  "research",
  "apply",
  "delivery",
  "native_receipt_lookup",
  "revocation",
  "readback",
  "read_intent",
] as const;
export type BackendCapability = (typeof BACKEND_CAPABILITIES)[number];

/**
 * The capability each backend accessor serves. `readback` has no accessor: no K01 operation reads native state back
 * through this port (native readback stays the application's domain read path), so no backend can serve it and the
 * conformance suite fails a registration that declares it.
 */
export const CAPABILITY_ACCESSORS = {
  research: "research",
  effects: "native_receipt_lookup",
  revocation: "revocation",
  apply: "apply",
  delivery: "delivery",
  readIntent: "read_intent",
} as const satisfies Record<string, BackendCapability>;

/** What `GET /describe` says about a backend before any store is opened. */
export interface BackendDescriptor {
  /** Registry id, e.g. `aiengineer-postgres`, `biotech-graph`, `in-memory`. */
  readonly id: string;
  readonly capabilities: readonly BackendCapability[];
  readonly storageClass: "relational" | "graph" | "memory";
  readonly writeAtomicity: "single_transaction" | "marker_plus_outbox";
  readonly nativeCancellation: "native" | "stop_dispatch_and_reconcile";
  /** The native contract `knowledge.apply` must name, when the backend declares `apply`. */
  readonly nativeContract: {
    readonly name: string;
    readonly version: string;
  } | null;
  /** The research store implementation, named when one binding reuses another's (Biotech reuses Postgres). */
  readonly researchStore: string | null;
  /**
   * Capabilities served only when a named host condition holds (never listed in `capabilities` too). An instance
   * serves exactly `capabilities` plus each conditional capability whose condition its {@link HostInjection} met.
   */
  readonly conditionalCapabilities: readonly ConditionalCapability[];
}

/** The host conditions a capability may depend on. */
export const CAPABILITY_CONDITIONS = {
  /** The executable injected a native `knowledge.apply` port (`HostInjection.apply` is not null). */
  host_injected_apply_port: {
    holds: (injection: Pick<HostInjection, "apply">) => injection.apply !== null,
    /** The injection override under which the condition does not hold (conformance creates the backend both ways). */
    unmet: { apply: null } satisfies Partial<HostInjection>,
  },
  /** The executable injected a native `knowledge.read_intent` port (`HostInjection.readIntent` is set). */
  host_injected_read_intent_port: {
    holds: (injection: Pick<HostInjection, "readIntent">) =>
      injection.readIntent !== null && injection.readIntent !== undefined,
    unmet: { readIntent: null } satisfies Partial<HostInjection>,
  },
} as const;
export type CapabilityCondition = keyof typeof CAPABILITY_CONDITIONS;

export interface ConditionalCapability {
  readonly capability: BackendCapability;
  readonly condition: CapabilityCondition;
}

/** What an instance created with `injection` must serve: the declaration plus every conditional whose condition holds. */
export function expectedCapabilities(
  descriptor: BackendDescriptor,
  injection: Pick<HostInjection, "apply" | "readIntent">,
): ReadonlySet<BackendCapability> {
  const expected = new Set<BackendCapability>(descriptor.capabilities);
  for (const conditional of descriptor.conditionalCapabilities) {
    if (CAPABILITY_CONDITIONS[conditional.condition].holds(injection)) expected.add(conditional.capability);
  }
  return expected;
}

/** Trusted, host-owned inputs a backend factory receives (never resolved from a request). */
export interface HostInjection {
  readonly externalCustody?: ExternalCustodyReader;
  readonly kinds: ReportKindCatalog;
  readonly auditor: AuditorDiscovery | null;
  readonly seal: SealKeys | null;
  /**
   * K08 source authority, use classes and judgment policies (Sprint OC WI-03): which uses are official or
   * consequential, when review is required and which judgment policies may admit a recommendation or forecast.
   * Absent: every use is `internal` and no judgment policy applies.
   */
  readonly authority?: SourceAuthorityCatalog | null;
  /**
   * The executor's native `knowledge.apply` port, when the executable wired one (the AI Engineer ingestion port needs
   * the AI Engineer knowledge database). A registration that serves `apply` from it declares `apply` conditional on
   * `host_injected_apply_port`; created without it, `knowledge.apply` refuses `SCHEMA_UNSUPPORTED`.
   */
  readonly apply: KnowledgeApplyPort | null;
  /**
   * The executor's native `knowledge.read_intent` port (OVE-204), when the executable wired one (the AI Engineer read
   * port needs the AI Engineer knowledge database). A registration serving it declares `read_intent` conditional on
   * `host_injected_read_intent_port`; absent, `knowledge.read_intent` refuses `SCHEMA_UNSUPPORTED`.
   */
  readonly readIntent?: KnowledgeReadIntentPort | null;
  /** The executor environment; a factory reads only the variable its `databaseUrlEnv` names. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BackendRegistration {
  readonly id: string;
  describe(): BackendDescriptor;
  create(config: BindingConfig, injection: HostInjection): Promise<KnowledgeOperationBackend>;
}

/** A capability the backend did not declare was asked for; answered as `SCHEMA_UNSUPPORTED`. */
export class BackendCapabilityMissing extends Error {
  constructor(
    readonly binding: string,
    readonly capability: BackendCapability,
  ) {
    super(`BACKEND_CAPABILITY_MISSING: ${binding} does not declare ${capability}`);
    this.name = "BackendCapabilityMissing";
  }
}

/** A configured binding no registration exports. */
export class UnknownBinding extends Error {
  constructor(
    readonly binding: string,
    readonly known: readonly string[],
  ) {
    super(`UNKNOWN_BINDING: ${binding} (registered: ${known.join(", ") || "none"})`);
    this.name = "UnknownBinding";
  }
}

export class BackendRegistry {
  readonly #registrations: ReadonlyMap<string, BackendRegistration>;

  constructor(registrations: readonly BackendRegistration[]) {
    const byId = new Map<string, BackendRegistration>();
    for (const registration of registrations) {
      if (byId.has(registration.id)) throw new Error(`DUPLICATE_BINDING: ${registration.id}`);
      if (registration.describe().id !== registration.id) {
        throw new Error(`BINDING_DESCRIPTOR_MISMATCH: ${registration.id}`);
      }
      byId.set(registration.id, registration);
    }
    this.#registrations = byId;
  }

  get(id: string): BackendRegistration {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new UnknownBinding(id, this.ids());
    return registration;
  }

  ids(): readonly string[] {
    return [...this.#registrations.keys()].sort();
  }
}

/** The ports a backend wires; each present port is one served capability ({@link CAPABILITY_ACCESSORS}). */
export interface BackendPorts {
  readonly research?: ResearchServices | null;
  readonly effects?: EffectLedger | null;
  readonly revocation?: RevocationEpochReader | null;
  readonly apply?: KnowledgeApplyPort | null;
  readonly delivery?: DeliveryReader | null;
  readonly readIntent?: KnowledgeReadIntentPort | null;
}

type BackendShape = Omit<KnowledgeOperationBackend, "capabilities" | keyof typeof CAPABILITY_ACCESSORS>;

/**
 * Build a backend whose `capabilities` are exactly the ports it wires and whose accessors throw
 * {@link BackendCapabilityMissing} for the others, so a backend cannot serve what it does not declare (describe honesty
 * by construction; the conformance suite checks the declaration of the registration against it).
 */
export function composeBackend(shape: BackendShape, ports: BackendPorts): KnowledgeOperationBackend {
  const capabilities = new Set<BackendCapability>();
  for (const [port, capability] of Object.entries(CAPABILITY_ACCESSORS)) {
    if (ports[port as keyof BackendPorts]) capabilities.add(capability);
  }
  const port = <T>(value: T | null | undefined, capability: BackendCapability): (() => T) => {
    return () => {
      if (value === null || value === undefined) throw new BackendCapabilityMissing(shape.binding, capability);
      return value;
    };
  };
  return {
    ...shape,
    capabilities,
    research: port(ports.research, "research"),
    effects: port(ports.effects, "native_receipt_lookup"),
    revocation: port(ports.revocation, "revocation"),
    apply: port(ports.apply, "apply"),
    delivery: port(ports.delivery, "delivery"),
    readIntent: port(ports.readIntent, "read_intent"),
  };
}
