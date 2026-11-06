import { readContentRepresentationAdmission } from "./content-representation-admission.js";
import { persistPreparedContentSummary } from "./content-summary-preparation.js";

/**
 * knowledge-db's `ContentAdmission` port over the canonical Postgres admission read and summary write.
 * Both run in the caller's transaction; the composition root injects this adapter (FINAL-REVIEW R1).
 */
export const postgresContentAdmission = Object.freeze({
  readRepresentationAdmission: readContentRepresentationAdmission,
  persistPreparedSummary: persistPreparedContentSummary,
});
