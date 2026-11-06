import type { RetrievalPolicy } from "../../src/index.js";
import { buildRetrievalPlan } from "../../src/index.js";
import { policy, printJson } from "./fixtures.js";

function messageOf(fn: () => unknown): string {
  try {
    fn();
    return "not_thrown";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A policy-scoped plan decomposes intent and subqueries, and admission fails
 * closed: a space or filter field the policy never admitted throws before any
 * retrieval stage runs, not after.
 */
export function planAndAdmissionExample() {
  const plan = buildRetrievalPlan("How to implement an API; compare tools?", policy, {
    hardFilters: [{ field: "language", op: "eq", value: "en" }],
  });

  const restrictedPolicy: RetrievalPolicy = {
    ...policy,
    admittedSpaces: ["engineering_claims"],
  };
  const spaceDenied = messageOf(() => buildRetrievalPlan("benchmark metrics", restrictedPolicy));

  const filterDenied = messageOf(() =>
    buildRetrievalPlan("agent-loop", policy, {
      hardFilters: [{ field: "secret", op: "eq", value: true }],
    }),
  );

  return {
    subqueryCount: plan.subqueries.length,
    intents: plan.intents,
    spaceDenied,
    filterDenied,
  };
}

if (process.argv[1]?.includes("01-plan-and-admission")) printJson(planAndAdmissionExample());
