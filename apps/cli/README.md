# ks — Knowledge Services CLI

One binary, `ks`, with the groups `knowledge`, `verify` and `db` (`jev` is reserved until Unit 5F; use the `jev` binary). `ks --help` and `ks <group> --help` list every command; the names are defined in `src/ks-commands.ts`. Each command runs under exactly one profile, chosen by the command and never by a failure:

- **remote** — the service through `KnowledgeClient`: `--base-url` or `KNOWLEDGE_API_URL`, the bearer in `KNOWLEDGE_API_TOKEN`, `--context '<OperationContext>'`, `--input '<json>'`, optional `--timeout-ms`, `--wait`, `--human`. Example: `ks knowledge store show …`, `ks verify citations … --wait`.
- **local** — host's local profile over a file store (`@aiengineer/knowledge-host/local` with the executor's file-backed seam until 5D3), loaded only for these commands: `ks verify capture source|file|list|read|search|locate|media-types`, `ks verify artifact register|get` and `ks verify chain claims|extraction|judge|policy|seal|check-report|status`. Store: `--store` or `KNOWLEDGE_LOCAL_STORE_DIR` (default `.knowledge-store`). Identity: `--tenant-id`, `--producer-deployment-id`, `--verifier-deployment-id`, `--producer-attempt-id`, `--verifier-attempt-id`, `--principal-salt`, `--git-sha` or the matching `KNOWLEDGE_LOCAL_*` variable. Providers only when named by `--providers capture,semantic` or `KNOWLEDGE_LOCAL_PROVIDERS`; keys come only from `KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY` and `KNOWLEDGE_LOCAL_AI_GATEWAY_API_KEY` (models `KNOWLEDGE_LOCAL_JUDGE_MODEL`, `KNOWLEDGE_LOCAL_CROSS_FAMILY_JUDGE_MODEL`). No `VERIFY_*` name is read. Without a named provider, online capture, document conversion and judging exit 2 with `CAPABILITY_NOT_ADMITTED`.
- **offline** — utilities over frozen files: `ks verify demo diagnostics-companies`, `ks verify benchmark capture diagnostics-companies`, `ks verify benchmark diff`, `ks verify attestation export|inspect`.

Exit codes: `0` success; `1` the command ran but its quality gate failed; `2` usage, authorization, network or executor error (JSON on stderr). `--help` and remote commands never load the local profile (`src/tests/remote-profile.test.ts` checks the bundle's module graph).

Build and package from the knowledge-services repository:

```powershell
corepack pnpm --filter @aiengineer/knowledge-cli... build
corepack pnpm --filter @aiengineer/knowledge-cli pack:sandbox   # dist/sandbox/ks-<version>.tgz with the platform-cli skills
node apps/cli/dist/index.js verify demo diagnostics-companies --dataset diagnostics-companies-v1 --output ./diagnostics-reports --open
```

The tarball installs outside the workspace with `npm i <tarball>`; its only runtime dependency is `zod`. It does not include the private demo assets, so the diagnostics demo and benchmark capture run from a workspace build. Resolve the script entry point to an absolute path when running from another directory. Output paths are relative to the invoking directory.

## Offline diagnostics demo

The demo uses packaged frozen inputs and needs no API credentials, Docker, or network access. It writes 26 files: four HTML reports and their Markdown and JSON counterparts, a linked evidence appendix in HTML and JSON, claim, field, source and run ledgers, metrics, semantic replay and adversarial-check results, a full-demo quality-gate record, verification bundle and file manifest. Citations link to retained evidence; cases absent from the frozen dataset are explicitly marked unavailable. The build verifies and copies the private retained source assets; those assets are not a public redistribution grant.

Choose a new output directory. Existing output is rejected. Files are prepared in an owned staging directory and published after generation succeeds. `--open` opens only `verification-audit.html` in an interactive terminal; automated runs leave it closed.

This version returns `verification_incomplete` with exit 2 because required full-demo verification paths are unavailable. The 13-gate record in `quality-gates.json` identifies each missing obligation; generated reports remain available for inspection. Missing or malformed required inputs also exit 2. A completed, fully evaluated gate failure exits 1; only a full gate pass exits 0. Report generation alone does not authorize success or policy admission.

The demo replays 38 retained Luna claims assessments from a pinned 498-artifact fixture without new provider calls. `gl-interested-comparison-mutated` and `gl-repeatability-mutated` are explicitly unavailable because their original captured judge outputs violated the semantic-output consistency rules; they are not treated as successful assessments. It also executes corrupted-locator and selected-digest mutations through the real extraction verifier. Assertion-text equality is mechanical; it does not establish semantic contradiction or qualifier preservation. The four-arm provider comparison, complete report replay, and capture/diff remain unfinished. Human-gold scoring is ineligible.

## Offline audit attestations

`ks verify attestation export` and `ks verify attestation inspect` are explicit local utilities. They do not load env files, contact an API, database, or provider, and they do not create or sign a durable verification run. Both require an already signed audit-bundle JSON file, a trusted public-key map JSON object (`{ "<key-id>": "<public PEM>" }`), and a trusted binding JSON object with exactly `builderId` and `keyId`. The builder ID must be the deployment-derived ID from the signed bundle; it is not supplied by the command.

```powershell
$env:KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM = Get-Content -Raw .\operator-attestation-private.pem
node apps/cli/dist/index.js verify attestation export --audit-bundle .\signed-audit.json --trusted-public-keys .\trusted-public-keys.json --trusted-binding .\trusted-binding.json --output .\signed-audit.dsse.json
node apps/cli/dist/index.js verify attestation inspect --audit-bundle .\signed-audit.json --trusted-public-keys .\trusted-public-keys.json --trusted-binding .\trusted-binding.json --attestation .\signed-audit.dsse.json
```

Export reads the private key only from `KNOWLEDGE_VERIFICATION_ATTESTATION_SIGNING_KEY_PEM`; there is no key command-line option and command output never includes it. It verifies the resulting envelope against the trusted public-key map before using exclusive creation for the single output file. Compact public metadata is returned on stdout. Inspection returns exit 0 only for a trusted exact attestation. A changed envelope, signature, subject, builder, parameters, or dependencies returns `verified:false` and exit 1.
