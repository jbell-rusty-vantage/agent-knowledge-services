import { resolve } from "node:path";
import { z } from "zod";

const PortSchema = z.coerce.number().int().min(0).max(65535);
const WorkerCountSchema = z.coerce.number().int().min(1).max(32);
const StringListSchema = z.array(z.string().min(1));

export function loadJevConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.JEV_HOST ?? "127.0.0.1";
  const token = env.JEV_SERVICE_TOKEN;
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !token) {
    throw new Error("JEV_SERVICE_TOKEN is required when binding outside loopback");
  }
  return {
    host,
    port: PortSchema.parse(env.JEV_PORT ?? "4318"),
    ...(token ? { token } : {}),
    service: {
      databasePath: resolve(env.JEV_DATABASE_PATH ?? ".jev/jobs.sqlite"),
      workers: WorkerCountSchema.parse(env.JEV_WORKERS ?? "4"),
      provider: {
        route: z.enum(["gateway", "direct"]).parse(env.JEV_PROVIDER ?? "gateway"),
        ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
      },
      inputPolicy: {
        allowedRoots: StringListSchema.parse(JSON.parse(env.JEV_ALLOWED_ROOTS ?? "[]")).map((path) => resolve(path)),
        remoteOrigins: StringListSchema.parse(JSON.parse(env.JEV_REMOTE_ORIGINS ?? "[]")),
      },
    },
  };
}
