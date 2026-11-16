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

/** The verification tools. Each description comes from the operation contract, as for every other tool. */
export function verificationToolDefinitions(options: KnowledgeMcpServerOptions) {
  const { definitions, add } = toolCollector();
  const executeVerification = createVerificationMcpToolExecutor(options);
  const executeBenchmarkRead = createBenchmarkReadMcpExecutor(options);
  for (const name of ["verify_benchmark_show", "verify_benchmark_manifest"] as const)
    add(name, benchmarkReadSchema.shape, async (value: unknown) => executeBenchmarkRead(name, value));
  add(
    "verify_reconciliation_apply",
    reconciliationApplySchema.shape,
    createProviderReconciliationMcpExecutor(options, "apply"),
  );
  add(
    "verify_reconciliation_show",
    reconciliationReadSchema.shape,
    createProviderReconciliationMcpExecutor(options, "show"),
  );
  add("verify_extraction_show", extractionReadSchema.shape, createStructuredExtractionReadMcpExecutor(options));
  add("verify_benchmark_comparison", comparisonReadSchema.shape, createBenchmarkComparisonReadMcpExecutor(options));
  add("verify_status", verificationOperationReadSchema.shape, createVerificationOperationReadMcpExecutor(options));
  for (const name of VERIFICATION_MCP_TOOL_NAMES)
    add(name, verificationToolSchemas[name].shape, async (value: unknown) => executeVerification(name, value));
  return definitions;
}
