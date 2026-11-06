# Designing Jev questions

Jev answers the question you wrote, not the one you meant. Most accuracy problems are wording
problems. Work in this loop: write → pilot on 20–50 items → read the wrong and low-confidence answers
→ move the missing reasoning into instructions or criteria → repeat.

## Choosing the primitive

| Answer shape | Primitive | Example |
|---|---|---|
| One of an unordered set | Choice | category, route, content format, language |
| A position on an ordered scale | Score | difficulty, severity, depth, relevance grade |
| A statement is true or false | Noul | "cites a benchmark", "contains PII", "excerpt supports claim" |
| Several properties may hold at once | several Nouls | multi-label tags, lifecycle stages |
| Pick the best from N candidates | Choice over candidate ids | skill selection, best passage, entity match |
| Should any candidate be used at all? | Noul per candidate | "is candidate 3 relevant?" (absolute, not relative) |

A Choice is **relative** (which option wins); Nouls are **absolute** (each may be low). Use a Choice
to pick and Nouls to decide whether to act at all.

## Writing instructions

- State the exact condition: "Is the PRIMARY subject of `transcript` …" — not "Is this about …".
- Name the part of state: `` `transcript` ``, `` `record.fields.title` ``, `` `messages[2].text` ``.
- Put dynamic reference data in an instructions object, not in the question sentence.
- Plain language a non-expert would read the same way. No double negatives.
- No hidden conjunctions: "technical AND production-ready" is two questions.

## Writing criteria

**Choice** — each option gets a one-line definition plus include/exclude rules for the boundary cases
you have seen go wrong:

```json
"inference_model_systems": "Serving trained models: batching, KV cache, quantization, inference engines. Include when serving performance is the main subject. Exclude training or fine-tuning methods.",
"other": "None of the listed categories is the primary subject."
```

Give the full option list, not a shortlist; extra options cost only a few tokens. If an option is
self-explanatory, its description may be `null`.

**Score** — levels ordered low → high, each describing an observable difference, 3–5 levels is usual:

```json
["Marketing or surface level: no mechanism explained",
 "Conceptual overview: explains ideas without implementation detail",
 "Implementation detail: concrete architecture, code, or configuration",
 "Expert internals: tradeoffs, failure analysis, or measured results"]
```

**Noul** — optional `true` / `false` descriptions sharpen boundaries:

```json
{ "type": "noul", "instructions": "`excerpt` supports `claim`.",
  "criteria": { "true": "The excerpt states or directly entails the claim.",
                "false": "The excerpt is unrelated, only topically similar, or contradicts the claim." } }
```

## Anti-patterns and rewrites

| Anti-pattern | Why it fails | Rewrite |
|---|---|---|
| "Rate this talk's quality 1–10" | several judgments hidden in one | Score depth, Score evidence, Noul vendor-pitch; weight in code |
| Difficulty as a Choice | ignores order; 43% in our pilot | Score over ordered levels |
| "How many tools does it mention?" | Jev cannot count | one Noul per candidate tool, sum in code |
| "Was this published before 2025?" | date math | extract date parts via Choice or regex, compare in code |
| Whole 400k-character document as state | context rot + token limit | filter to relevant windows, or chunk and combine |
| "Is this NOT unrelated to X?" | double negative | "Is this about X?" |
| Noul where `true` means "no" | criteria contradict instructions | make `true` the yes case |
| Carrying a Noul threshold to a Choice | not comparable | calibrate each question separately |

## Speculative fan-out

Adding questions to a request barely changes latency and costs only their input tokens. Ask every
question your code might need in one call, including ones you may ignore. This is how to get a
concept-by-document matrix: one Noul per concept in a vocabulary, over each document. Keep each
question short, because the 32k budget covers state plus the **longest** question and 64k covers all
of them.

## Versioning question sets

Treat a question set as an artifact: give it an id and version, store it as JSON, and hash it. Record
that hash with every result and every calibration threshold. Changing one word is a new version.
