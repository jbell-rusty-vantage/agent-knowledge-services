import { gatewaySemanticConfigurationDigest } from "./gateway.js";
import { providerDigest } from "./port.js";
import { INTERFAZE_MODEL, interfazeConfigurationDigest } from "./interfaze.js";
import { deepFreeze } from "../internal/deep-freeze.js";

export type ProviderPromotionState = "lab" | "offline" | "shadow" | "admitted" | "suspended" | "retired";
export interface ProviderModalityRegistration {
  readonly capability: string;
  readonly modality: "text" | "image" | "audio";
  readonly promotionState: ProviderPromotionState;
  readonly evidence: "ws06_live_synthetic" | "unadmitted";
  readonly remainingPromotionGates: readonly string[];
}
export interface ProviderRegistration {
  readonly providerId: string;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly string[];
  readonly modalities: readonly string[];
  readonly modalityStates: readonly ProviderModalityRegistration[];
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly retryLimit: 0;
  readonly toolPolicy: readonly string[];
  readonly promotionState: ProviderPromotionState;
  readonly schemaPolicy: "bounded_object_json_schema";
  readonly configurationDigest: `sha256:${string}`;
}

const testedLab = (capability: string, modality: "text" | "image" | "audio"): ProviderModalityRegistration =>
  deepFreeze({
    capability,
    modality,
    promotionState: "lab",
    evidence: "ws06_live_synthetic",
    remainingPromotionGates: ["persisted cost reconciliation", "human-controlled promotion review"],
  });
const lab = (capability: string, modality: "text" | "image" | "audio"): ProviderModalityRegistration =>
  deepFreeze({
    capability,
    modality,
    promotionState: "lab",
    evidence: "unadmitted",
    remainingPromotionGates: ["synthetic live conformance", "persisted cost reconciliation", "promotion review"],
  });

export const providerRegistry: readonly ProviderRegistration[] = deepFreeze([
  {
    providerId: "gateway-structured-extraction.v1",
    provider: "vercel-ai-gateway",
    model: "openai/gpt-5.6-luna",
    capabilities: ["structured_extraction"],
    modalities: ["text"],
    modalityStates: [testedLab("structured_extraction", "text")],
    maxRequestBytes: 96_000,
    maxResponseBytes: 96_000,
    timeoutMs: 60_000,
    retryLimit: 0,
    toolPolicy: ["no_tools", "no_search", "no_gui"],
    promotionState: "lab",
    schemaPolicy: "bounded_object_json_schema",
    configurationDigest: providerDigest({
      kind: "gateway-structured-extraction.v1",
      endpoint: "https://ai-gateway.vercel.sh/v1/chat/completions",
      model: "openai/gpt-5.6-luna",
      temperature: 0,
      maxCompletionTokens: 900,
      toolPolicy: ["no_tools", "no_search", "no_gui"],
    }),
  },
  {
    providerId: "gateway-semantic-rubric-haiku.v1",
    provider: "vercel-ai-gateway",
    model: "anthropic/claude-haiku-4.5",
    capabilities: ["semantic_evidence_rubric"],
    modalities: ["text"],
    modalityStates: [testedLab("semantic_evidence_rubric", "text")],
    maxRequestBytes: 96_000,
    maxResponseBytes: 96_000,
    timeoutMs: 60_000,
    retryLimit: 0,
    toolPolicy: ["no_tools", "no_search", "no_gui"],
    promotionState: "lab",
    schemaPolicy: "bounded_object_json_schema",
    configurationDigest: gatewaySemanticConfigurationDigest("anthropic/claude-haiku-4.5"),
  },
  {
    providerId: "nli-semantic-judge.v1",
    provider: "recorded-nli-boundary",
    model: "nli-three-way-lab",
    capabilities: ["semantic_nli"],
    modalities: ["text"],
    modalityStates: [lab("semantic_nli", "text")],
    maxRequestBytes: 96_000,
    maxResponseBytes: 96_000,
    timeoutMs: 60_000,
    retryLimit: 0,
    toolPolicy: ["no_tools", "no_search", "no_gui"],
    promotionState: "lab",
    schemaPolicy: "bounded_object_json_schema",
    configurationDigest: providerDigest({
      kind: "nli-semantic-judge.v1",
      model: "nli-three-way-lab",
      toolPolicy: ["no_tools", "no_search", "no_gui"],
    }),
  },
  {
    providerId: "interfaze-extraction.v1",
    provider: "interfaze",
    model: INTERFAZE_MODEL,
    capabilities: [
      "structured_extraction",
      "fixed_task_ocr",
      "fixed_task_object_detection",
      "fixed_task_scraper",
      "fixed_task_speech_to_text",
      "fixed_task_translate",
    ],
    modalities: ["text", "image", "audio"],
    modalityStates: [
      testedLab("structured_extraction", "text"),
      testedLab("fixed_task_ocr", "image"),
      lab("fixed_task_object_detection", "image"),
      lab("fixed_task_scraper", "text"),
      lab("fixed_task_speech_to_text", "audio"),
      lab("fixed_task_translate", "text"),
    ],
    maxRequestBytes: 160_000,
    maxResponseBytes: 160_000,
    timeoutMs: 60_000,
    retryLimit: 0,
    toolPolicy: ["no_tools", "no_search", "no_gui"],
    promotionState: "lab",
    schemaPolicy: "bounded_object_json_schema",
    configurationDigest: interfazeConfigurationDigest,
  },
]);

export function registeredProvider(providerId: string): ProviderRegistration {
  const match = providerRegistry.find((item) => item.providerId === providerId);
  if (!match) throw new Error("PROVIDER_NOT_REGISTERED");
  return match;
}
