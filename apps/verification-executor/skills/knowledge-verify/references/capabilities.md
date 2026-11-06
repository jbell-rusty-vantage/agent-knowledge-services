# Choosing evidence

This reference ships with the skill. It describes executor capture and locate paths, not every
internal verification-library capability. Pin the sandbox tarball digest and the complete
installed skill content together.

## Start with the intended assertion

Write one proposition with its subject, value, population, conditions and date. Bind each
supporting/contradicting/context quote to a captured source. A locator says where the evidence
is; it does not decide whether the proposition follows. Claims verification, semantic
assessment and policy were retired from the executor in SV-17; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component.

## Choose a media path

| Input | Executor path | What you may conclude |
|---|---|---|
| Text, Markdown, JSON | capture-file, then read/search/locate | Exact text exists in the captured representation |
| HTML | capture URL or file, then locate converted text | Text attribution; not browser DOM/layout verification |
| PDF, Office, OpenDocument, RTF, EPUB, CSV | executor document parser, then locate returned text; requires configured provider | Text attribution to a converted document; not native page/cell-coordinate validation |
| Raw image, audio or video | Unsupported by capture-file | Stop and report the missing admitted media path |
| Transcript already available as text | Capture that text with its source identity | Evidence about the transcript, not independent validation of the original recording |

The library also has PDF-page, DOM, geometry, table, transcript-timecode, repository, dataset,
API-record, JSON-pointer and character-range selectors. These are not accepted fields in
executor captures or locate requests. Do not invent a selector payload or use agent-authored
conversion to evade the missing media path. Follow the host's admitted preparation flow.

## Worked scenario and failure handling

The source says “Panel A has 42 samples” and “Panel B has 42 samples”. Locating “42 samples”
returns `ambiguous`. Read the returned context, copy the full Panel A sentence, then locate it
again. `resolved` means the quote occurs exactly once in the capture; it does not establish
semantic support. A seal is not admission.

Read the failed status rather than treating exit 1 as an outage. Missing provider credentials or
unsupported media is an explicit configuration/capability problem, not evidence to invent.

## Runnable scaffold

```sh
node examples/offline.mjs /absolute/path/to/installed/knowledge-verify/dist/index.js
```

Run from this skill directory with Node >=24. The template clears inherited executor/provider
configuration, makes a private temporary store and invokes the real local CLI. It deletes only
that store when done. Expected summary: an ambiguous quote extended and resolved, a registered
and read-back artifact, the retired commands exiting `2`, and an unsupported image rejected.
No external providers are mocked because none are called; content is synthetic. This is an
offline demonstration, not a production authorization or live-provider smoke test.

See [failure playbook](failure-playbook.md).
