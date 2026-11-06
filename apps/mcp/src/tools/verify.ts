import { VERIFICATION_MCP_TOOL_NAMES } from "../catalog.js";
import {
  benchmarkReadSchema,
  comparisonReadSchema,
  createBenchmarkComparisonReadMcpExecutor,
  createBenchmarkReadMcpExecutor,
  createProviderReconciliationMcpExecutor,
  createStructuredExtractionReadMcpExecutor,
  createVerificationMcpToolExecutor,
  createVerificationOperationReadMcpExecutor,
  extractionReadSchema,
  reconciliationApplySchema,
  reconciliationReadSchema,
  verificationOperationReadSchema,
  verificationToolSchemas,
  type KnowledgeMcpServerOptions,
} from "./executors.js";
import { toolCollector } from "./definition.js";

export function verificationToolDefinitions(options: KnowledgeMcpServerOptions) {
  const { definitions, add } = toolCollector();
  const executeVerification = createVerificationMcpToolExecutor(options);
  const executeBenchmarkRead = createBenchmarkReadMcpExecutor(options);
  for (const name of ["verify_benchmark_show", "verify_benchmark_manifest"] as const)
    add(
      name,
      {
        description:
          "Read a completed, signed benchmark with compact engineering metadata under the caller's tenant read authority.",
        inputSchema: benchmarkReadSchema.shape,
      },
      async (value: unknown) => executeBenchmarkRead(name, value),
    );
  add(
    "verify_reconciliation_apply",
    {
      description:
        "Apply a registered signed accounting decision under configured operator authority; never redispatches.",
      inputSchema: reconciliationApplySchema.shape,
    },
    createProviderReconciliationMcpExecutor(options, "apply"),
  );
  add(
    "verify_reconciliation_show",
    {
      description: "Read an authenticated applied accounting decision.",
      inputSchema: reconciliationReadSchema.shape,
    },
    createProviderReconciliationMcpExecutor(options, "show"),
  );
  add(
    "verify_extraction_show",
    {
      description: "Read compact authenticated extraction custody results; candidates remain unverified.",
      inputSchema: extractionReadSchema.shape,
    },
    createStructuredExtractionReadMcpExecutor(options),
  );
  add(
    "verify_benchmark_comparison",
    {
      description:
        "Read signed paired engineering statistics and corrected p-values for a completed benchmark comparison.",
      inputSchema: comparisonReadSchema.shape,
    },
    createBenchmarkComparisonReadMcpExecutor(options),
  );
  add(
    "verify_status",
    {
      description:
        "Poll the state and receipt ids of a tenant-owned verification operation; read the kind-specific terminal result once state is succeeded.",
      inputSchema: verificationOperationReadSchema.shape,
    },
    createVerificationOperationReadMcpExecutor(options),
  );
  for (const name of VERIFICATION_MCP_TOOL_NAMES)
    add(
      name,
      {
        description: `Bounded ${name} workflow through in-process verification admission.`,
        inputSchema: verificationToolSchemas[name].shape,
      },
      async (value: unknown) => executeVerification(name, value),
    );
  return definitions;
}
