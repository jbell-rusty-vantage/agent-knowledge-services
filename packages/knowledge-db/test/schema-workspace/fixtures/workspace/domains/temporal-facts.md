---
id: dom:temporal-facts
kind: domain
schemas: [temporal]
aliases: [facts, two-clock, bitemporal, history, timeline, knowledge head, batch]
---

# Temporal facts (two clocks)

A fact is a `temporal.segment` on a `temporal.stream`. Current = `k_to is null` and `valid_during @> now()`.
Read paths: `q:entity.at`, `q:facts.history_for_stream`, `q:knowledge.head`. Write path: executor only.
