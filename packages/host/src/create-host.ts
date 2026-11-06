import {
  createLocalHost,
  type LocalHost,
  type LocalHostOptions,
  type LocalVerificationServices,
} from "./local/local-host.js";
import { createApiHost, type ApiHost, type ApiHostOptions } from "./server/api.js";
import { createMcpHost, type McpHost, type McpHostOptions } from "./server/mcp.js";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "./server/worker.js";

export type HostOptions = ApiHostOptions | McpHostOptions | WorkerHostOptions | LocalHostOptions;

/** A profile createHost does not compose; the remote CLI, for one, never constructs host. */
export class HostProfileUnavailableError extends Error {
  readonly code = "HOST_PROFILE_UNAVAILABLE";
  constructor(readonly profile: string) {
    super(`HOST_PROFILE_UNAVAILABLE:${profile}`);
  }
}

/** Composes the services a profile and role actually construct; the return type follows them. */
export function createHost(options: ApiHostOptions): Promise<ApiHost>;
export function createHost(options: McpHostOptions): Promise<McpHost>;
export function createHost(options: WorkerHostOptions): Promise<WorkerHost>;
export function createHost<S extends LocalVerificationServices>(options: LocalHostOptions<S>): Promise<LocalHost<S>>;
export async function createHost(options: HostOptions): Promise<ApiHost | McpHost | WorkerHost | LocalHost> {
  if (options.profile === "local") return createLocalHost(options);
  if (options.profile !== "server")
    throw new HostProfileUnavailableError((options as { readonly profile: string }).profile);
  switch (options.role) {
    case "api":
      return createApiHost(options);
    case "mcp":
      return createMcpHost(options);
    case "worker":
      return createWorkerHost(options);
  }
}
