import type { ReadExecutor } from "@aiengineer/knowledge-db";
import type { IngestionIntentInput } from "../../src/ingestion/intent.js";
export function withSnapshot(
  reads: Pick<ReadExecutor, "head" | "runIntent">,
  intent: IngestionIntentInput,
): Promise<IngestionIntentInput>;
