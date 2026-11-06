#!/usr/bin/env node
import { DEFAULT_COMPONENT_ROOT, loadComponent } from "./component.js";
import { InstallRefused, inspect, install } from "./installer.js";
import { registerSealKey } from "./seal-keys.js";

/**
 * knowledge-db manifest [--component-root <dir>]
 * knowledge-db install --admin-dsn-env <NAME> --installation-id <uuid> --application <id> --binding <name> [--component-root <dir>]
 * knowledge-db inspect --admin-dsn-env <NAME> [--component-root <dir>]
 * knowledge-db seal-key --admin-dsn-env <NAME> --key-id <id> --key-file <PKCS#8 PEM> [--issuer <name>] [--retire <id,...>]
 *   pins the PUBLIC half of the executor's run-seal key (OVE-169 W1 D25); idempotent; never prints key material.
 *   Until it runs, `report.seal` refuses CAPABILITY_UNAVAILABLE / `seal_key_unregistered`: a provisioning gap that
 *   this command closes, not a transient fault. Callers must not auto-retry the seal; retry once the key is pinned.
 *
 * The DSN is read from the NAMED environment variable and never printed. Exit 0 = passed, 2 = refused gate, 1 = error.
 */
function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function dsnFromEnvironment(): string {
  const name = required("admin-dsn-env");
  const dsn = process.env[name];
  if (!dsn) throw new InstallRefused("ADMIN_DSN_MISSING", `environment variable ${name} is not set`);
  return dsn;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const component = loadComponent(option("component-root") ?? DEFAULT_COMPONENT_ROOT);
  switch (command) {
    case "manifest":
      process.stdout.write(`${JSON.stringify(component.manifest, null, 2)}\n`);
      return 0;
    case "install": {
      const receipt = await install(component, {
        adminDsn: dsnFromEnvironment(),
        installationId: required("installation-id"),
        applicationId: required("application"),
        binding: required("binding"),
        appliedBy: option("applied-by") ?? "knowledge-db",
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return 0;
    }
    case "inspect": {
      const inspection = await inspect(component, dsnFromEnvironment());
      process.stdout.write(
        `${JSON.stringify({ ...inspection, componentDigest: component.manifest.component_digest }, null, 2)}\n`,
      );
      return inspection.complete ? 0 : 2;
    }
    case "seal-key": {
      const retire = option("retire");
      const issuer = option("issuer");
      const receipt = await registerSealKey({
        adminDsn: dsnFromEnvironment(),
        keyId: required("key-id"),
        keyFile: required("key-file"),
        ...(issuer ? { issuer } : {}),
        ...(retire
          ? {
              retire: retire
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : {}),
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        "usage: knowledge-db manifest | install | inspect | seal-key\n" +
          "  seal-key --admin-dsn-env <NAME> --key-id <id> --key-file <PKCS#8 PEM> [--issuer <name>] [--retire <id,...>]\n" +
          "    pins the executor's seal key; report.seal refuses CAPABILITY_UNAVAILABLE/seal_key_unregistered until\n" +
          "    then (a provisioning gap: do not auto-retry the seal)\n",
      );
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof InstallRefused) {
      process.stdout.write(`${JSON.stringify({ refused: error.code, detail: error.message })}\n`);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
