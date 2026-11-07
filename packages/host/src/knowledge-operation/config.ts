import { KS_DB_COMPONENT_DSN_VARIABLES } from "../config/database.js";
import type { ExternalCustodyReader } from "@aiengineer/knowledge-research-core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuditorDiscovery,
  type DiscoveryScript,
  ReportKindCatalog,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
} from "@aiengineer/knowledge-application";
import { QualificationReceiptSchema } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import {
  DispatchRegistry,
  type InstalledBinding,
  JwksCache,
  KnowledgeCredentialVerifier,
  loadKnowledgeAuthConfig,
} from "./auth.js";
import { type SealKeys, sealKeysFromFile } from "./backends.js";
import type { KnowledgeApplyPort, KnowledgeOperationBackend, KnowledgeReadIntentPort } from "./ports.js";
import type { BackendRegistration, BackendRegistry } from "./registry.js";
import { KnowledgeOperationService } from "./service.js";

/**
 * Environment of the `ks.knowledge_operation.v2` surface (names only; values are never logged):
 *
 *  KS_KNOWLEDGE_ISSUER            pinned credential issuer (e.g. `mission-control`)
 *  KS_KNOWLEDGE_AUDIENCE          this executor's exact audience
 *  KS_KNOWLEDGE_JWKS_FILE | _URL  the issuer's public JWKS (file path, or https/loopback http URL)
 *  KS_KNOWLEDGE_BINDINGS_JSON     installed bindings: JSON array of
 *                                 {application, binding, installationId, databaseUrlEnv?, tenants?}
 *                                 `databaseUrlEnv` is `KS_AIENG_DB_COMPONENT_DSN` or `KS_BIOTECH_DB_COMPONENT_DSN` (the NAME of the
 *                                 variable holding that binding's component DSN; read by the database config module)
 *  KS_KNOWLEDGE_SEAL_KEY_ID + KS_KNOWLEDGE_SEAL_KEY_FILE   optional K07 run-seal key (PKCS#8 PEM); unset, sealing refuses
 *  KS_KNOWLEDGE_SEAL_ISSUER       descriptor `signingIssuer` (default `knowledge-services`)
 *  KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE  optional scripted census auditor (deterministic test double); refused at
 *                                 startup unless KS_KNOWLEDGE_DISPOSABLE=1 (disposable proofs only, WI-03 S7); unset and
 *                                 no injected auditor, `report.assess` refuses INDEPENDENCE_UNPROVEN. `describe`
 *                                 advertises `auditorKind` (`scripted` | `independent` | `none`)
 *  KS_KNOWLEDGE_REPORT_KINDS_DIR  K08 report-kind catalogue (default: the repository `catalog/research/report-kinds`)
 *  KS_KNOWLEDGE_SOURCE_AUTHORITY_DIR  K08 source authority rules (default `catalog/research/source-authority`); its
 *                                 sibling `use-classes.json` and `judgment-policies.json` decide official/consequential
 *                                 uses, required review and governed judgments (WI-03)
 *  KS_KNOWLEDGE_QUALIFICATION_FILE optional JSON array of K01 qualification receipts advertised by `describe`
 *
 * Binding selection: each configured `binding` is a registry id, resolved through the {@link BackendRegistry} the
 * executable composes from explicit `BACKEND` imports (the host imports no binding package). Registered today by the
 * verification executor: `aiengineer-postgres` (K05; needs `databaseUrlEnv`, component >= 2.4.0), `biotech-graph` (K06;
 * without `databaseUrlEnv` it is installed and answers SCHEMA_UNSUPPORTED) and `in-memory` (demos/tests only). An id no
 * registration exports refuses at startup (`UNKNOWN_BINDING`).
 */
const BindingConfigSchema = z.strictObject({
  application: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  binding: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  installationId: z.string().min(1).max(200),
  databaseUrlEnv: z.enum(KS_DB_COMPONENT_DSN_VARIABLES).optional(),
  tenants: z.array(z.string().min(1).max(200)).min(1).optional(),
});
export type BindingConfig = z.infer<typeof BindingConfigSchema>;

type Env = Readonly<Record<string, string | undefined>>;

export interface KnowledgeOperationSurface {
  readonly service: KnowledgeOperationService;
  readonly backends: readonly KnowledgeOperationBackend[];
  close(): Promise<void>;
}

/** Trusted host injection (never resolved from a request). */
export interface KnowledgeOperationInjection {
  readonly externalCustody?: ExternalCustodyReader;
  /** The backend registrations the executable composes; `config.ts` resolves each configured `binding` through it. */
  readonly registry: BackendRegistry;
  readonly auditor?: AuditorDiscovery;
  /** The executable's native `knowledge.apply` port; offered to every registration, served by one declaring it. */
  readonly apply?: KnowledgeApplyPort;
  /** The executable's native `knowledge.read_intent` port; offered to every registration, served by one declaring it. */
  readonly readIntent?: KnowledgeReadIntentPort;
}

function catalogDir(name: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, "catalog", "research", name);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return resolve(process.cwd(), "catalog", "research", name);
}

export function defaultReportKindsDir(): string {
  return catalogDir("report-kinds");
}

export function defaultSourceAuthorityDir(): string {
  return catalogDir("source-authority");
}

export async function createKnowledgeOperationSurfaceFromEnv(
  env: Env,
  injection: KnowledgeOperationInjection,
): Promise<KnowledgeOperationSurface | undefined> {
  const auth = loadKnowledgeAuthConfig(env);
  const bindingsJson = env.KS_KNOWLEDGE_BINDINGS_JSON?.trim();
  if (auth === undefined) {
    if (bindingsJson) throw new Error("KS_KNOWLEDGE_ISSUER_REQUIRED");
    return undefined;
  }
  if (!bindingsJson) throw new Error("KS_KNOWLEDGE_BINDINGS_JSON_REQUIRED");
  const configs = z.array(BindingConfigSchema).min(1).max(16).parse(JSON.parse(bindingsJson));
  const kinds = ReportKindCatalog.fromDirectory(env.KS_KNOWLEDGE_REPORT_KINDS_DIR?.trim() || defaultReportKindsDir());
  const authority = SourceAuthorityCatalog.fromDirectory(
    env.KS_KNOWLEDGE_SOURCE_AUTHORITY_DIR?.trim() || defaultSourceAuthorityDir(),
  );
  const sealKeyId = env.KS_KNOWLEDGE_SEAL_KEY_ID?.trim();
  const sealKeyFile = env.KS_KNOWLEDGE_SEAL_KEY_FILE?.trim();
  if ((sealKeyId ? 1 : 0) !== (sealKeyFile ? 1 : 0)) throw new Error("KS_KNOWLEDGE_SEAL_KEY_ID_AND_FILE_REQUIRED");
  const seal: SealKeys | null = sealKeyId && sealKeyFile ? sealKeysFromFile(sealKeyId, sealKeyFile) : null;
  // S9: the use-class registry decides official/consequential uses; a missing one is a host configuration error.
  if (authority.useClasses === null) throw new Error("KS_KNOWLEDGE_USE_CLASSES_REQUIRED");
  const scriptFile = env.KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE?.trim();
  if (scriptFile && env.KS_KNOWLEDGE_DISPOSABLE?.trim() !== "1") {
    throw new Error(
      "KS_KNOWLEDGE_SCRIPTED_AUDITOR_REQUIRES_DISPOSABLE: set KS_KNOWLEDGE_DISPOSABLE=1 for a disposable proof",
    );
  }
  const auditor =
    injection.auditor ??
    (scriptFile ? new ScriptedAuditorDiscovery(JSON.parse(readFileSync(scriptFile, "utf8")) as DiscoveryScript) : null);
  const qualificationFile = env.KS_KNOWLEDGE_QUALIFICATION_FILE?.trim();
  const qualification = qualificationFile
    ? z.array(QualificationReceiptSchema).parse(JSON.parse(readFileSync(qualificationFile, "utf8")))
    : [];

  // Resolve every configured binding before any store is opened: an unknown id refuses with nothing to close.
  const registrations: [BindingConfig, BackendRegistration][] = configs.map((config) => [
    config,
    injection.registry.get(config.binding),
  ]);
  const backends: KnowledgeOperationBackend[] = [];
  try {
    for (const [config, registration] of registrations) {
      backends.push(
        await registration.create(config, {
          kinds,
          auditor,
          seal,
          authority,
          apply: injection.apply ?? null,
          readIntent: injection.readIntent ?? null,
          ...(injection.externalCustody ? { externalCustody: injection.externalCustody } : {}),
          env,
        }),
      );
    }
  } catch (error) {
    await Promise.all(backends.map((backend) => backend.close().catch(() => undefined)));
    throw error;
  }
  const installed: InstalledBinding[] = configs.map((config) => ({
    application: config.application,
    binding: config.binding,
    installationId: config.installationId,
    tenants: config.tenants ?? null,
  }));
  const verifier = new KnowledgeCredentialVerifier({
    issuer: auth.issuer,
    audience: auth.audience,
    jwks: new JwksCache(auth.jwks),
  });
  const service = new KnowledgeOperationService({
    verifier,
    backends,
    installed,
    dispatches: new DispatchRegistry(),
    signingIssuer: env.KS_KNOWLEDGE_SEAL_ISSUER?.trim() || "knowledge-services",
    qualification,
    onBackgroundError: (error) =>
      console.error(
        JSON.stringify({
          event: "knowledge_operation_runner_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      ),
  });
  return {
    service,
    backends,
    close: async () => {
      await service.settled().catch(() => undefined);
      await Promise.all(backends.map((backend) => backend.close()));
    },
  };
}
