import { z } from "zod";

export * from "./auth.js";

const ServerConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  LOG_LEVEL: z.string().default("info"),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  return ServerConfigSchema.parse(environment);
}

const SemanticJudgeConfigSchema = z.object({
  SEMANTIC_PRIMARY_PROVIDER: z.string().default("gateway-semantic-rubric-haiku.v1"),
  SEMANTIC_CROSS_FAMILY_PROVIDER: z.string().default(""),
  SEMANTIC_MAX_INPUT_CHARACTERS: z.coerce.number().int().min(1).max(64_000).default(64_000),
  SEMANTIC_TOOL_CATALOG: z
    .string()
    .default("")
    .refine((value) => value.trim() === "", "semantic judges must have an empty tool catalog"),
});
export type SemanticJudgeConfig = z.infer<typeof SemanticJudgeConfigSchema>;

export function loadSemanticJudgeConfig(environment: NodeJS.ProcessEnv = process.env): SemanticJudgeConfig {
  return SemanticJudgeConfigSchema.parse(environment);
}
