# Executor examples

From the repository root (Node >=24, installed workspace dependencies):

```sh
corepack pnpm --filter @aiengineer/knowledge-verification-executor build
corepack pnpm --filter @aiengineer/knowledge-verification-executor examples
```

The maintained executable is [the distributed skill template](../skills/knowledge-verify/examples/offline.mjs).
It invokes the real built CLI in local mode, captures a synthetic text file, refuses an
ambiguous quote, extends it to a unique sentence, compiles a claim, verifies it mechanically,
and observes policy holding an unjudged claim. It also verifies seven configured extraction
comparisons, rejects a changed value and missing options, and refuses raw image capture.

Expected JSON: mechanical `passed`, semanticJudged `0`, policy `review` or `abstain`,
extraction `passed`, changedValue/missingRuleOptions `rejected`, rawImage `unsupported`.
The script exits nonzero on interface or behavior drift. It creates and deletes its own
temporary store, clears inherited provider/remote/host configuration, and makes no paid calls,
database writes, or network calls. Only the agent's choices and source content are synthetic;
capture, intent validation, verification, policy, persistence, receipts and CLI exit gates are real.

The same template ships inside the sandbox skill; run it with the absolute path to the
installed CLI JavaScript entrypoint. Extend the fixture or intent to explore a new field,
keeping the temporary store and explicit expected outcomes. Live judge/parser checks are
separate and are not established by this example. A held claim must not be published.

See [acquisition capabilities](CAPABILITIES-ACQUISITION.md) and the [library capability matrix](../../../packages/verification/CAPABILITIES.md)
for media coverage, assertion versus verification, and public-surface limitations.
