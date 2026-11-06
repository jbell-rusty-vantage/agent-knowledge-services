import type { LocalServiceConfig, LocalVerificationSeam, LocalVerificationServices } from "@aiengineer/knowledge-host";
import { captureFileMediaKind, type CaptureFileInput, type CaptureInput } from "./capture.js";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";

type Input<M extends keyof VerificationExecutor> = VerificationExecutor[M] extends (input: infer I) => unknown
  ? I
  : never;

/** Executor configuration from the host's local config only; ambient provider credentials never reach it. */
function executorEnvironment({
  storeDir,
  identity,
  providers,
}: LocalServiceConfig): Readonly<Record<string, string | undefined>> {
  return {
    VERIFY_STORE_DIR: storeDir,
    VERIFY_TENANT_ID: identity.tenantId,
    VERIFY_PRODUCER_DEPLOYMENT_ID: identity.producerDeploymentId,
    VERIFY_VERIFIER_DEPLOYMENT_ID: identity.verifierDeploymentId,
    VERIFY_PRODUCER_ATTEMPT_ID: identity.producerAttemptId,
    VERIFY_VERIFIER_ATTEMPT_ID: identity.verifierAttemptId,
    FIRECRAWL_API_KEY: providers.capture?.firecrawlApiKey,
  };
}

/**
 * Binds the executor's capture and artifact tools over the host's store directory, identity and capture provider.
 * SV-17 retired the file-backed verification chain (claims, extraction, judge, policy, seal, report check, status).
 */
async function createExecutorLocalServices(config: LocalServiceConfig) {
  const executor = await VerificationExecutor.create(loadExecutorConfig(executorEnvironment(config)));
  return {
    supportedMediaTypes: () => executor.supportedMediaTypes(),
    captureFile: (input: CaptureFileInput) => executor.captureFile(input),
    captureSource: (input: CaptureInput) => executor.captureSource(input),
    listCaptures: () => executor.listCaptures(),
    readCapture: (input: Input<"readCapture">) => executor.readCapture(input),
    searchCapture: (input: Input<"searchCapture">) => executor.searchCapture(input),
    locateQuote: (input: Input<"locateQuote">) => executor.locateQuote(input),
    registerArtifact: (input: Input<"registerArtifact">) => executor.registerArtifact(input),
    artifact: (input: Input<"artifact">) => executor.artifact(input),
  } satisfies LocalVerificationServices;
}

/**
 * The executor's capture and artifact tools for `createHost({ profile: "local" })`. Host admits each operation,
 * including document conversion through the same media-type resolution captureFile applies, before calling it.
 */
export const executorLocalVerification = {
  captureMediaKind: captureFileMediaKind,
  create: createExecutorLocalServices,
} satisfies LocalVerificationSeam<Awaited<ReturnType<typeof createExecutorLocalServices>>>;
