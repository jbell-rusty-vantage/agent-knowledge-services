# ks — Knowledge Services CLI

One binary, `ks`, with the groups `knowledge` and `verify` and the commands `ks guide [topic]` and `ks describe <ref>`. There is no `db` or `jev` group: schema, bounded-read and ingestion commands are the executor's `knowledge` binary, and Jev is the `jev` binary. `ks --help` lists the groups, `ks <group> --help` lists the group's commands with what each does, and `ks <command> --help` adds when to use it and what it returns. The names are defined in `src/ks-commands.ts`, and the descriptions are the operation contracts' (`@aiengineer/knowledge-contracts`), the same text the MCP tools and the OpenAPI document carry. Each command runs under exactly one profile, chosen by the command and never by a failure:

- **remote** — the service through `KnowledgeClient`: `--base-url` or `KNOWLEDGE_API_URL`, the bearer in `KNOWLEDGE_API_TOKEN`, `--context '<OperationContext>'`, `--input '<json>'`, optional `--timeout-ms`, `--wait`, `--human`. Example: `ks knowledge store show …`, `ks verify extract … --wait`.
- **local** — host's local profile over a file store (`@aiengineer/knowledge-host/local` with the executor's file-backed seam until 5D3), loaded only for these commands: `ks verify capture source|file|list|read|search|locate|media-types` and `ks verify artifact register|get`. Store: `--store` or `KNOWLEDGE_LOCAL_STORE_DIR` (default `.knowledge-store`). Identity: `--tenant-id`, `--producer-deployment-id`, `--verifier-deployment-id`, `--producer-attempt-id`, `--verifier-attempt-id` or the matching `KNOWLEDGE_LOCAL_*` variable. The one provider, `capture`, is used only when named by `--providers capture` or `KNOWLEDGE_LOCAL_PROVIDERS`; its key comes only from `KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY`. No `VERIFY_*` name is read. Without the named provider, online capture and document conversion exit 2 with `CAPABILITY_NOT_ADMITTED`.
- **offline** — `ks guide [topic]`, `ks describe <ref>`, and the utilities over frozen files: `ks verify benchmark capture diagnostics-companies`, `ks verify benchmark diff`, `ks verify attestation export|inspect`.

`ks guide` prints the guidance as Markdown: without a topic the start page (what the service is for, the jobs in the order a research task meets them with the skill and the tools of each, three rules); `ks guide <skill>` a skill; `ks guide <skill>/references/<name>` one of its references; `ks guide tools` every tool by job and `ks guide topics` every page. An unknown topic exits 2 with `NOT_FOUND` and the valid topics. The pages are the files of `skills/`, bundled in the binary, and are the ones the MCP tool `knowledge_guide` and `GET /v1/guide[/topic]` return.

`ks knowledge operation status` polls any `knowledge` operation and `ks knowledge operation result` returns what it produced: the identifiers and digests each finished step recorded (`representationId`, `chunkSetId`, …), which the next command takes. `ks knowledge embed status` was another name for the status command and is gone.

`ks describe <ref>` explains one tool, operation or skill: its purpose, the JSON Schema of its input, notes on what the schema cannot express, a valid example, the result and the related operations. `ref` is `tool:<MCP tool name>`, `operation:<kind>` or `skill:<name>`; an unknown reference exits 2 with `NOT_FOUND` and the valid names. The answer is the one the MCP tool `knowledge_describe` and `GET /v1/describe?ref=` return, computed from the contracts in the binary without a service.

A command that submits an operation checks `--input` against the operation's schema before it sends anything. An input the schema refuses exits 2 with `{"code":"INVALID_CONTRACT","issues":[{"path","message"}],"help":"ks describe operation:<kind>"}`: the code and issue list the API and the MCP tool return for the same input.

Exit codes: `0` success; `1` the command ran but its quality gate failed; `2` usage, authorization, network or executor error (JSON on stderr). `--help` and remote commands never load the local profile (`src/tests/remote-profile.test.ts` checks the bundle's module graph).

Build and package from the knowledge-services repository:

```powershell
corepack pnpm --filter @aiengineer/knowledge-cli... build
corepack pnpm --filter @aiengineer/knowledge-cli pack:sandbox   # dist/sandbox/ks-<version>.tgz with the platform-cli skills
node apps/cli/dist/index.js describe tool:knowledge_source_fetch --human
```

The tarball installs outside the workspace with `npm i <tarball>`; its only runtime dependency is `zod`. It does not include the private retained assets, so benchmark capture runs from a workspace build. Resolve the script entry point to an absolute path when running from another directory. Output paths are relative to the invoking directory.

## Offline audit attestations

`ks verify attestation export` and `ks verify attestation inspect` are explicit local utilities. They do not load env files, contact an API, database, or provider, and they do not create or sign a durable verification run. Both require an already signed audit-bundle JSON file, a trusted public-key map JSON object (`{ "<key-id>": "<public PEM>" }`), and a trusted binding JSON object with exactly `builderId` and `keyId`. The builder ID must be the deployment-derived ID from the signed bundle; it is not supplied by the command.

```powershell
$env:KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM = Get-Content -Raw .\operator-attestation-private.pem
node apps/cli/dist/index.js verify attestation export --audit-bundle .\signed-audit.json --trusted-public-keys .\trusted-public-keys.json --trusted-binding .\trusted-binding.json --output .\signed-audit.dsse.json
node apps/cli/dist/index.js verify attestation inspect --audit-bundle .\signed-audit.json --trusted-public-keys .\trusted-public-keys.json --trusted-binding .\trusted-binding.json --attestation .\signed-audit.dsse.json
```

Export reads the private key only from `KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM`; there is no key command-line option and command output never includes it. It verifies the resulting envelope against the trusted public-key map before using exclusive creation for the single output file. Compact public metadata is returned on stdout. Inspection returns exit 0 only for a trusted exact attestation. A changed envelope, signature, subject, builder, parameters, or dependencies returns `verified:false` and exit 1.
