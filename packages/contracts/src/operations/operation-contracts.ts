import { z } from "zod";
import type { OperationKind } from "../integration.js";
import type { OperationContract } from "./contract-types.js";
import { EVALUATION_OPERATIONS } from "./evaluation-operations.js";
import { PREPARATION_OPERATIONS } from "./preparation-operations.js";
import { PROMOTION_OPERATIONS } from "./promotion-operations.js";
import { RETRIEVAL_OPERATIONS } from "./retrieval-operations.js";
import { SOURCE_OPERATIONS } from "./source-operations.js";
import { STORE_OPERATIONS } from "./store-operations.js";
import { VERIFICATION_OPERATIONS } from "./verification-operations.js";

/** The references `describe` answers. */
export const DESCRIBE_PREFIXES = Object.freeze(["tool:", "operation:", "skill:"] as const);
export const DescribeInputSchema = z.strictObject({ ref: z.string().trim().min(1).max(200) });

/** The operation that explains the others. */
export const DESCRIBE_OPERATION: OperationContract = {
  operation: "describe",
  effect: "read",
  summary:
    "Explain one tool, operation or skill: purpose, full input schema, field notes, a valid example and the result.",
  when: "Use before the first call of a tool: the tool list shows only the required fields of each input, and not the fields of context.",
  returns:
    "Returns the description, or NOT_FOUND with the valid prefixes (tool:, operation:, skill:) and the names under the one you used.",
  input: DescribeInputSchema,
  shape: "bare",
  notes: [
    "ref is tool:<MCP tool name>, operation:<operation kind or read name> or skill:<skill name>.",
    "A tool answer gives the arguments of that tool; an operation answer gives the input alone, with every tool, ks command and HTTP route that runs it.",
  ],
  example: { ref: "tool:knowledge_source_fetch" },
  result: {
    name: "Description",
    outcome:
      "A tool or operation answer has description, the input schema, notes, example, result (name, shape, outcome), related and surfaces. A skill answer has name, version, description, surfaces and operations.",
  },
  related: ["tool:knowledge_guide"],
  mcp: ["knowledge_describe"],
  cli: ["describe"],
  http: ["GET /v1/describe"],
};

/** The topics `guide` answers besides one page per skill and per skill file. */
export const GUIDE_FIXED_TOPICS = Object.freeze(["start", "tools", "topics"] as const);
export const GuideInputSchema = z.strictObject({ topic: z.string().trim().min(1).max(200).optional() });

/** The operation an agent calls first: where to start, and every skill and reference as a page. */
export const GUIDE_OPERATION: OperationContract = {
  operation: "guide",
  effect: "read",
  summary: "Read the guidance as Markdown: the start page, or one skill or one reference of a skill.",
  when: "Call it first, without a topic, for the jobs, the skill and the tools of each job and the rules that always hold.",
  returns:
    "Returns one Markdown page that ends with the topics it links to. Read a skill, then only the reference the step you are on needs.",
  input: GuideInputSchema,
  shape: "bare",
  notes: [
    "Without a topic the answer is the start page. tools lists every tool by job and server; topics lists every page.",
    "A skill name returns that skill's SKILL.md; <skill>/<path> returns one of its files, for example knowledge-research/references/method. A trailing .md is accepted.",
    "The pages are the files of the skills directory, so an agent with a filesystem and an agent with only this tool read the same text.",
    "An unknown topic is refused with NOT_FOUND and the list of valid topics.",
  ],
  example: { topic: "knowledge-research" },
  result: {
    name: "GuidePage",
    outcome:
      "Markdown text, not JSON. Over HTTP the content type is text/markdown; on MCP it is the text content of the result.",
  },
  related: ["tool:knowledge_describe"],
  mcp: ["knowledge_guide"],
  cli: ["guide"],
  http: ["GET /v1/guide", "GET /v1/guide/{topic}"],
};

/** Every operation with a written contract, in the order a caller meets them. */
export const OPERATION_CONTRACTS: readonly OperationContract[] = Object.freeze([
  GUIDE_OPERATION,
  DESCRIBE_OPERATION,
  ...SOURCE_OPERATIONS,
  ...PREPARATION_OPERATIONS,
  ...PROMOTION_OPERATIONS,
  ...STORE_OPERATIONS,
  ...RETRIEVAL_OPERATIONS,
  ...EVALUATION_OPERATIONS,
  ...VERIFICATION_OPERATIONS,
]);

const byOperation = new Map(OPERATION_CONTRACTS.map((contract) => [contract.operation, contract]));
const byTool = new Map(
  OPERATION_CONTRACTS.flatMap((contract) => contract.mcp.map((tool) => [tool, contract] as const)),
);
const byCommand = new Map(
  OPERATION_CONTRACTS.flatMap((contract) => contract.cli.map((command) => [command, contract] as const)),
);
const byRoute = new Map(
  OPERATION_CONTRACTS.flatMap((contract) => contract.http.map((route) => [route, contract] as const)),
);
const byKind = new Map(
  OPERATION_CONTRACTS.flatMap((contract) => (contract.kind ? [[contract.kind, contract] as const] : [])),
);

/** The MCP tools of the platform server, in catalog order. */
export const PLATFORM_TOOL_NAMES: readonly string[] = Object.freeze([...byTool.keys()]);

export const operationContract = (operation: string): OperationContract | undefined => byOperation.get(operation);
/** Every operation kind has a contract (the contract tests enforce it), so a kind without one is a defect. */
export function operationContractForKind(kind: OperationKind): OperationContract {
  const contract = byKind.get(kind);
  if (!contract) throw new Error(`OPERATION_CONTRACT_MISSING:${kind}`);
  return contract;
}
export const operationContractForTool = (tool: string): OperationContract | undefined => byTool.get(tool);
export const operationContractForCommand = (command: string): OperationContract | undefined => byCommand.get(command);
/** `route` is `METHOD /path` in OpenAPI path form, for example `POST /v1/captures/{resourceId}:vet`. */
export const operationContractForRoute = (route: string): OperationContract | undefined => byRoute.get(route);

type DescriptionLines = Pick<OperationContract, "summary" | "when" | "returns">;
const lines = (text: DescriptionLines) => `${text.summary}\n${text.when}\n${text.returns}`;

/** The three description lines of an operation: what it does, when to use it, the result and what to call next. */
export const operationDescription = (contract: OperationContract): string => lines(contract);

/** The description an MCP tool publishes: the three lines of the operation it runs. */
export function toolDescription(tool: string): string | undefined {
  const contract = byTool.get(tool);
  return contract && lines(contract);
}

/** The same description for `ks --help`: each tool name that has a command is written as that command. */
export function commandDescription(command: string): string | undefined {
  const contract = byCommand.get(command);
  if (!contract) return undefined;
  return lines(contract).replace(/\b(?:knowledge|verify)_[a-z_]+\b/gu, (tool) => {
    // A tool whose operation has no command keeps its name.
    const name = byTool.get(tool)?.cli[0];
    return name ? `ks ${name}` : tool;
  });
}
