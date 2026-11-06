import { type ComponentDatabase, PostgresResearchBinding } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { TARGET_BINDING } from "./contracts.js";

/**
 * Operational K02 records of Biotech (runs, reports, observations, seals, decisions, operations) live in the SAME
 * knowledge_verification component, installed in the Biotech application PostgreSQL (installation `biotech`); the
 * graph is never a second run store (design K06). The PostgreSQL stores are reused unchanged under binding
 * `biotech-graph`; custody of report bodies and ledgers is the component `artifact_custody` (the BKS consumer reads
 * inline payload bytes from the same table, and official reads compare the graph Report against these digests).
 */
export function biotechResearchBinding(
  db: ComponentDatabase,
  options: ConstructorParameters<typeof PostgresResearchBinding>[2] = {},
): PostgresResearchBinding {
  return new PostgresResearchBinding(db, TARGET_BINDING, options);
}
