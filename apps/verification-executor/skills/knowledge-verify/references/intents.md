# Intent files (retired)

The claims, extraction and report intent files (`verification-claims-intent.v1`,
`verification-extraction-intent.v1`, `verification-report-intent.v1`) were consumed only by
the executor's verification chain, which was retired in SV-17: `verify-claims`, `verify-extraction`, `judge`, `policy`, `seal`, `check-report` and `status`
exit `2` with `retired (SV-17)`. Claims, runs and seals go through ks.knowledge_operation.v2 (K01)
on the knowledge_verification component. The executor still captures, locates and registers
artifacts; see [the skill](../SKILL.md).
