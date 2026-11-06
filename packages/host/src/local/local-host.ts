import { resolve } from "node:path";
import { constructWithResources, type HostResources } from "../lifecycle/resources.js";
import {
  HostCapabilityNotAdmittedError,
  isLocalOperation,
  localVerificationOperations,
  type LocalMethod,
  type LocalOperation,
} from "./capabilities.js";

/** Online capture: HTTPS GET, plus Firecrawl scraping and document conversion when a key is supplied. */
export interface LocalCaptureProvider {
  readonly firecrawlApiKey?: string;
}

/** Explicit provider configuration; the local profile never reads provider credentials from the environment. */
export interface LocalProviders {
  readonly capture?: LocalCaptureProvider;
}

/** Receipt identity for local runs; the services apply their own defaults for omitted fields. */
export interface LocalIdentity {
  readonly tenantId?: string;
  readonly producerDeploymentId?: string;
  readonly verifierDeploymentId?: string;
  readonly producerAttemptId?: string;
  readonly verifierAttemptId?: string;
}

/** What host hands the file-backed services: an absolute store directory and only the configured providers. */
export interface LocalServiceConfig {
  readonly storeDir: string;
  readonly identity: LocalIdentity;
  readonly providers: LocalProviders;
}

export interface LocalCaptureFileDescriptor {
  readonly filename: string;
  readonly mediaType?: string;
}

/** The file-backed capture and artifact services the local profile composes. */
export type LocalVerificationServices = { readonly [M in LocalMethod]: (...args: never[]) => unknown };

/**
 * The verification executor supplies its file-backed capture and artifact tools (SV-17 retired its verification
 * chain; verification runs, claims and seals are served by ks.knowledge_operation.v2).
 */
export interface LocalVerificationSeam<S extends LocalVerificationServices> {
  /** Pure: how `captureFile` would convert this input. Host admits `document` conversion before constructing. */
  readonly captureMediaKind: (input: LocalCaptureFileDescriptor) => "text" | "html" | "document" | undefined;
  /**
   * Constructs the services on first use. Resources it acquires are registered on `resources` and released
   * by `close()`, or immediately when construction fails.
   */
  readonly create: (config: LocalServiceConfig, resources: HostResources) => Promise<S> | S;
}

export interface LocalHostOptions<S extends LocalVerificationServices = LocalVerificationServices> {
  readonly profile: "local";
  readonly storeDir: string;
  readonly identity?: LocalIdentity;
  readonly providers?: LocalProviders;
  readonly verification: LocalVerificationSeam<S>;
}

export interface LocalHostCapabilities {
  readonly onlineCapture: boolean;
  readonly documentConversion: boolean;
  readonly database: false;
}

export type LocalVerifyOperations<S extends LocalVerificationServices> = {
  readonly [M in LocalMethod]: S[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export interface LocalHost<S extends LocalVerificationServices = LocalVerificationServices> {
  readonly profile: "local";
  readonly storeDir: string;
  readonly capabilities: LocalHostCapabilities;
  /** Every operation call admits, then constructs the services on first use. */
  readonly verify: LocalVerifyOperations<S>;
  /** Whether this host executes the operation (a verification tool name); anything else is server-only. */
  admits(operation: string): boolean;
  /** Idempotent: waits for running operations, then releases; concurrent and later callers await the same cleanup. */
  close(): Promise<void>;
}

const isCaptureFileDescriptor = (input: unknown): input is LocalCaptureFileDescriptor =>
  typeof input === "object" && input !== null && typeof (input as { filename?: unknown }).filename === "string";

function localServiceConfig(options: LocalHostOptions<LocalVerificationServices>): LocalServiceConfig {
  if (typeof options.storeDir !== "string" || options.storeDir.trim() === "")
    throw new Error("HOST_LOCAL_STORE_DIR_REQUIRED");
  if (typeof options.verification?.create !== "function" || typeof options.verification.captureMediaKind !== "function")
    throw new Error("HOST_LOCAL_VERIFICATION_SERVICES_REQUIRED");
  const { capture } = options.providers ?? {};
  if (capture?.firecrawlApiKey !== undefined && capture.firecrawlApiKey.trim() === "")
    throw new Error("HOST_LOCAL_CAPTURE_PROVIDER_KEY_INVALID");
  return {
    storeDir: resolve(options.storeDir),
    identity: { ...options.identity },
    providers: { ...(capture ? { capture: { ...capture } } : {}) },
  };
}

/**
 * Composes the local profile. Nothing is constructed here: the store directory, services and any
 * resources they own are created on the first admitted operation call, so `--help` or a rejected
 * operation touches no store, network or database.
 */
export async function createLocalHost<S extends LocalVerificationServices>(
  options: LocalHostOptions<S>,
): Promise<LocalHost<S>> {
  const config = localServiceConfig(options);
  const capabilities: LocalHostCapabilities = {
    onlineCapture: config.providers.capture !== undefined,
    documentConversion: config.providers.capture?.firecrawlApiKey !== undefined,
    database: false,
  };
  type Built = { readonly value: S; readonly resources: HostResources };
  let construction: Promise<Built> | undefined;
  let closing: Promise<void> | undefined;
  const running = new Set<Promise<unknown>>();

  const start = (): Promise<Built> => {
    const attempt = constructWithResources((resources) => options.verification.create(config, resources));
    construction = attempt;
    // A failed start has already released what it acquired; the next call starts again.
    attempt.catch(() => {
      if (construction === attempt) construction = undefined;
    });
    return attempt;
  };
  const services = async (): Promise<S> => {
    if (closing) throw new Error("HOST_CLOSED:local");
    const built = await (construction ?? start());
    if (closing) throw new Error("HOST_CLOSED:local");
    return built.value;
  };

  const requirement = (operation: string) => {
    if (!isLocalOperation(operation)) return "server-profile" as const;
    const { requires } = localVerificationOperations[operation];
    if (requires === "capture-provider" && !capabilities.onlineCapture) return requires;
    return undefined;
  };
  const admit = (operation: LocalOperation, input: unknown) => {
    const missing = requirement(operation);
    if (missing) throw new HostCapabilityNotAdmittedError("local", operation, missing);
    if (
      operation === "verify_capture_file" &&
      !capabilities.documentConversion &&
      isCaptureFileDescriptor(input) &&
      options.verification.captureMediaKind(input) === "document"
    )
      throw new HostCapabilityNotAdmittedError("local", operation, "document-conversion");
  };

  const call =
    (operation: LocalOperation) =>
    (...args: unknown[]) => {
      const run = (async () => {
        admit(operation, args[0]);
        const target = await services();
        const method = localVerificationOperations[operation].method;
        return (target[method] as (...values: unknown[]) => unknown)(...args);
      })();
      running.add(run);
      const settled = () => void running.delete(run);
      run.then(settled, settled);
      return run;
    };
  const verify = Object.fromEntries(
    (Object.keys(localVerificationOperations) as LocalOperation[]).map((operation) => [
      localVerificationOperations[operation].method,
      call(operation),
    ]),
  ) as unknown as LocalVerifyOperations<S>;

  return {
    profile: "local",
    storeDir: config.storeDir,
    capabilities,
    verify,
    admits: (operation) => requirement(operation) === undefined,
    close: () => {
      closing ??= (async () => {
        await Promise.allSettled([...running]);
        const pending = construction;
        if (!pending) return;
        const built = await pending.catch(() => undefined);
        await built?.resources.close();
      })();
      return closing;
    },
  };
}
