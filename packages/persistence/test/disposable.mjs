import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export function validateDisposableTarget(input) {
  const projects = [...input.config.matchAll(/^project_id\s*=\s*"([^"\r\n]+)"\s*$/gm)];
  const project = projects[0]?.[1];
  if (projects.length !== 1 || !project || !/^(?:vfy|disposable)-[a-z0-9][a-z0-9-]{5,63}$/.test(project))
    throw new Error("DISPOSABLE_PROJECT_REQUIRED");
  const url = new URL(input.databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  )
    throw new Error("DISPOSABLE_DATABASE_URL_DENIED");
  const container = input.container;
  const labels = container.Config.Labels;
  const ports = container.NetworkSettings.Ports["5432/tcp"] ?? [];
  if (
    !container.State.Running ||
    container.Name !== `/supabase_db_${project}` ||
    labels["com.supabase.cli.project"] !== project ||
    resolve(labels["com.supabase.cli.workdir"] ?? "") !== resolve(input.projectDirectory) ||
    !ports.some((port) => port.HostPort === url.port)
  )
    throw new Error("DISPOSABLE_CONTAINER_IDENTITY_MISMATCH");
  return project;
}

/** Check the disposable project and actual Docker binding before opening any database connection. */
export function disposableDatabaseUrl(env = process.env) {
  const databaseUrl = env.KS_TEST_DATABASE_URL;
  if (!databaseUrl) {
    if (env.KS_REQUIRE_CURRENT_SCHEMA === "1") throw new Error("KS_TEST_DATABASE_URL_REQUIRED");
    return undefined;
  }
  if (!env.KS_TEST_PROJECT_DIR) throw new Error("KS_TEST_PROJECT_DIR_REQUIRED");
  const projectDirectory = realpathSync(env.KS_TEST_PROJECT_DIR);
  const config = readFileSync(resolve(projectDirectory, "supabase/config.toml"), "utf8");
  const project = /^project_id\s*=\s*"([^"\r\n]+)"\s*$/m.exec(config)?.[1];
  if (!project || !/^(?:vfy|disposable)-[a-z0-9][a-z0-9-]{5,63}$/.test(project))
    throw new Error("DISPOSABLE_PROJECT_REQUIRED");
  const containers = JSON.parse(
    execFileSync("docker", ["inspect", `supabase_db_${project}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }),
  );
  if (containers.length !== 1) throw new Error("DISPOSABLE_CONTAINER_IDENTITY_MISMATCH");
  validateDisposableTarget({ databaseUrl, projectDirectory, config, container: containers[0] });
  return databaseUrl;
}

export function disposableStorageConfig(env = process.env) {
  const projectUrl = env.KS_TEST_SUPABASE_URL,
    secretKey = env.KS_TEST_SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) {
    if (env.KS_REQUIRE_CURRENT_SCHEMA === "1") throw new Error("DISPOSABLE_STORAGE_CONFIGURATION_REQUIRED");
    return undefined;
  }
  if (!disposableDatabaseUrl(env)) throw new Error("DISPOSABLE_DATABASE_REQUIRED_FOR_STORAGE");
  const projectDirectory = realpathSync(env.KS_TEST_PROJECT_DIR);
  const config = readFileSync(resolve(projectDirectory, "supabase/config.toml"), "utf8");
  const project = /^project_id\s*=\s*"([^"\r\n]+)"\s*$/m.exec(config)?.[1];
  const url = new URL(projectUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("DISPOSABLE_STORAGE_ENDPOINT_REQUIRED");
  const containers = JSON.parse(
    execFileSync("docker", ["inspect", `supabase_kong_${project}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    }),
  );
  const container = containers[0];
  if (
    containers.length !== 1 ||
    !container.State.Running ||
    container.Name !== `/supabase_kong_${project}` ||
    container.Config.Labels["com.supabase.cli.project"] !== project ||
    resolve(container.Config.Labels["com.supabase.cli.workdir"] ?? "") !== projectDirectory ||
    !(container.NetworkSettings.Ports["8000/tcp"] ?? []).some((port) => port.HostPort === url.port)
  )
    throw new Error("DISPOSABLE_STORAGE_CONTAINER_IDENTITY_MISMATCH");
  return { projectUrl, secretKey };
}
