import { sha256Digest } from "@aiengineer/knowledge-core";
import { DETERMINISTIC_PROVIDER_KEY, DOCLING_PROVIDER_KEY, UNSTRUCTURED_PROVIDER_KEY } from "./constants.js";
import { requiresAlternateConversion } from "./deterministic/inspect.js";
import { isExclusiveTextMediaType } from "./media-type.js";
import type {
  ConversionFailureClass,
  ConversionOutput,
  ConversionRequest,
  ConversionRouteAttempt,
  ConversionRouteOptions,
  ConversionRouterProviders,
  ConversionRoutingReceipt,
  DocumentConversionProvider,
} from "./types.js";

const ABSENT_PROVIDER_VERSION = "absent";

const FAILURE_CLASS_PATTERNS: readonly {
  pattern: RegExp;
  failureClass: ConversionFailureClass;
}[] = [
  { pattern: /DENIED/, failureClass: "policy_denied" },
  { pattern: /TIMEOUT|POLL_LIMIT/, failureClass: "timeout" },
  { pattern: /UNAVAILABLE|ECONN|fetch failed/i, failureClass: "provider_unavailable" },
  { pattern: /INVALID|SCHEMA|DIGEST/, failureClass: "invalid_output" },
];

type RoutingReceiptCore = Omit<ConversionRoutingReceipt, "receiptDigest">;

function classifyConversionFailure(error: unknown): ConversionFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  return FAILURE_CLASS_PATTERNS.find((entry) => entry.pattern.test(message))?.failureClass ?? "provider_failed";
}

function providerRef(provider: DocumentConversionProvider): string {
  return `${provider.providerKey}@${provider.version}`;
}

function absentProvider(providerKey: string): DocumentConversionProvider {
  return {
    providerKey,
    version: ABSENT_PROVIDER_VERSION,
    supports: () => false,
    convert: async () => {
      throw new Error("CONVERSION_PROVIDER_ABSENT");
    },
  };
}

function isRouterProviderBundle(
  value: DocumentConversionProvider | ConversionRouterProviders,
): value is ConversionRouterProviders {
  return "deterministic" in value && !("convert" in value);
}

function resolveRouterProviders(
  first: DocumentConversionProvider | ConversionRouterProviders,
  docling?: DocumentConversionProvider,
  unstructured?: DocumentConversionProvider,
): {
  deterministic: DocumentConversionProvider;
  docling: DocumentConversionProvider;
  unstructured: DocumentConversionProvider;
} {
  const bundle: ConversionRouterProviders = isRouterProviderBundle(first)
    ? first
    : {
        deterministic: first,
        ...(docling ? { docling } : {}),
        ...(unstructured ? { unstructured } : {}),
      };
  return {
    deterministic: bundle.deterministic,
    docling: bundle.docling ?? absentProvider(DOCLING_PROVIDER_KEY),
    unstructured: bundle.unstructured ?? absentProvider(UNSTRUCTURED_PROVIDER_KEY),
  };
}

function admittedKeySet(options: ConversionRouteOptions): ReadonlySet<string> | undefined {
  return options.admittedKeys ? new Set(options.admittedKeys) : undefined;
}

function isAdmitted(provider: DocumentConversionProvider, admitted: ReadonlySet<string> | undefined): boolean {
  return admitted === undefined || admitted.has(provider.providerKey);
}

function routeAttempt(input: {
  provider: DocumentConversionProvider;
  ordinal: number;
  outcome: ConversionRouteAttempt["outcome"];
  failureClass?: ConversionFailureClass;
}): ConversionRouteAttempt {
  return {
    providerKey: input.provider.providerKey,
    providerVersion: input.provider.version,
    ordinal: input.ordinal,
    outcome: input.outcome,
    ...(input.failureClass ? { failureClass: input.failureClass } : {}),
  };
}

function secretFreeSnapshot(value: unknown): ReturnType<typeof JSON.parse> {
  return JSON.parse(JSON.stringify(value));
}

function sealRoutingReceipt(core: RoutingReceiptCore): ConversionRoutingReceipt {
  return {
    ...core,
    receiptDigest: sha256Digest(secretFreeSnapshot(core)),
  };
}

function exhaustedMessage(attempts: readonly ConversionRouteAttempt[]): string {
  return `CONVERSION_EXHAUSTED:${attempts
    .map((attempt) => `${attempt.providerKey}:${attempt.failureClass}`)
    .join("|")}`;
}

async function tryProviderConversion(
  provider: DocumentConversionProvider,
  request: ConversionRequest,
  ordinal: number,
): Promise<{ output?: ConversionOutput; attempt: ConversionRouteAttempt }> {
  try {
    const output = await provider.convert(request);
    if (requiresAlternateConversion(output.fidelity)) {
      return {
        attempt: routeAttempt({
          provider,
          ordinal,
          outcome: "failed",
          failureClass: "invalid_output",
        }),
      };
    }
    return {
      output,
      attempt: routeAttempt({ provider, ordinal, outcome: "succeeded" }),
    };
  } catch (error) {
    return {
      attempt: routeAttempt({
        provider,
        ordinal,
        outcome: "failed",
        failureClass: classifyConversionFailure(error),
      }),
    };
  }
}

export function conversionRouterFromProviders(providers: readonly DocumentConversionProvider[]): ConversionRouter {
  const byKey = new Map(providers.map((provider) => [provider.providerKey, provider]));
  const deterministic = byKey.get(DETERMINISTIC_PROVIDER_KEY);
  if (!deterministic) {
    throw new Error("CONVERSION_ROUTER_MISSING_DETERMINISTIC");
  }
  const docling = byKey.get(DOCLING_PROVIDER_KEY);
  const unstructured = byKey.get(UNSTRUCTURED_PROVIDER_KEY);
  return new ConversionRouter({
    deterministic,
    ...(docling ? { docling } : {}),
    ...(unstructured ? { unstructured } : {}),
  });
}

export class ConversionRouter {
  private readonly deterministic: DocumentConversionProvider;
  private readonly docling: DocumentConversionProvider;
  private readonly unstructured: DocumentConversionProvider;

  constructor(
    deterministicOrProviders: DocumentConversionProvider | ConversionRouterProviders,
    docling?: DocumentConversionProvider,
    unstructured?: DocumentConversionProvider,
  ) {
    const providers = resolveRouterProviders(deterministicOrProviders, docling, unstructured);
    this.deterministic = providers.deterministic;
    this.docling = providers.docling;
    this.unstructured = providers.unstructured;
  }

  candidates(request: ConversionRequest, options: ConversionRouteOptions = {}): readonly DocumentConversionProvider[] {
    const admitted = admittedKeySet(options);
    if (isExclusiveTextMediaType(request.profile.mediaType)) {
      return isAdmitted(this.deterministic, admitted) ? [this.deterministic] : [];
    }
    return this.structuredCandidates(request, admitted);
  }

  async convertWithReceipt(
    request: ConversionRequest,
    options: ConversionRouteOptions = {},
  ): Promise<{ output: ConversionOutput; receipt: ConversionRoutingReceipt }> {
    const candidates = this.candidates(request, options);
    const candidateRoute = candidates.map(providerRef);
    const attempts: ConversionRouteAttempt[] = [];
    for (const [ordinal, provider] of candidates.entries()) {
      const result = await tryProviderConversion(provider, request, ordinal);
      attempts.push(result.attempt);
      if (result.output) {
        return {
          output: result.output,
          receipt: sealRoutingReceipt({
            requestDigest: result.output.requestDigest,
            candidateRoute,
            attempts,
            selectedProviderKey: provider.providerKey,
            fallbackUsed: ordinal > 0,
          }),
        };
      }
    }
    throw new Error(exhaustedMessage(attempts));
  }

  async convert(request: ConversionRequest): Promise<ConversionOutput> {
    return (await this.convertWithReceipt(request)).output;
  }

  private structuredCandidates(
    request: ConversionRequest,
    admitted: ReadonlySet<string> | undefined,
  ): DocumentConversionProvider[] {
    const eligible = (provider: DocumentConversionProvider): boolean =>
      provider.supports(request.profile) && isAdmitted(provider, admitted);
    const route: DocumentConversionProvider[] = [];
    if (eligible(this.deterministic)) route.push(this.deterministic);
    if (eligible(this.docling)) route.push(this.docling);
    if (request.profile.managedProcessingAllowed && eligible(this.unstructured)) {
      route.push(this.unstructured);
    }
    return route;
  }
}
