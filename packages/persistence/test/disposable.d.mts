interface ContainerIdentity {
  Name: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
}
export function validateDisposableTarget(input: {
  databaseUrl: string;
  projectDirectory: string;
  config: string;
  container: ContainerIdentity;
}): string;
export function disposableDatabaseUrl(env?: NodeJS.ProcessEnv): string | undefined;
export function disposableStorageConfig(env?: NodeJS.ProcessEnv): { projectUrl: string; secretKey: string } | undefined;
