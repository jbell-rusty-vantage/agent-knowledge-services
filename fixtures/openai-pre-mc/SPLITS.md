# Candidate label splits

Candidate claims, queries, synthetic negatives, and qrels now carry evaluator-only
development, calibration, or held-out assignments. These are engineering candidates,
not human-reviewed gold. The runner must hide every candidate label from producers.

| Split | Candidate families |
|---|---|
| development | 2024 GPT-4o; 2025 deep-research announcement and system card; 2026 development families |
| calibration | 2024 Sora; 2025 agent-building-tools announcement and Operator system card; 2026 calibration families |
| held-out | 2024 o1; 2025 o3/o4-mini announcement and system card; 2026 GPT-5.6 families |

Related source families, paraphrases, and synthetic mutations stay in their assigned
split. Candidate binding validation currently reports 36 queries, 30 synthetic negatives,
48 qrels, and 126 exact claim-row/split/reference checks. This does not satisfy the
fixture's human-gold requirement, per-year held-out adequacy, label-poisoning test, or
release acceptance.
