# Domain documentation and engineering skills

Start with the root [glossary](../../GLOSSARY.md), [architecture decisions](../architecture/), the [final platform specification](../specs/belllabs-knowledge-platform/SPECIFICATION.md), then the relevant [knowledge concept](../../knowledge/index.md) and cited code/tests.

Use a shared root glossary for platform contracts and domain-specific terminology in the owning domain repository. Package count alone does not justify duplicating glossaries. AI Engineer migration authority and Biotech schema authority stay explicit. Accepted target decisions do not rewrite current implementation evidence.

The existing ADR home is `docs/architecture/`; retain it rather than create a competing `docs/adr/` numbering sequence. ADRs 0005–0015 describe this program. Explain contradictions and amend their owning documents; do not silently prefer a historical copy or generated navigation page.

The Matt Pocock planning skills are installed under `.agents/skills/`, copied from the existing Mission Control installation. `to-spec` synthesizes without interviewing; `to-tickets` produces complete vertical slices with blocking edges; `triage` uses the configured labels and durable agent briefs. Setup decisions follow [issue tracker](issue-tracker.md) and [label mapping](triage-labels.md). The program owner preapproved the normal planning confirmation steps for this task.

Engineering planning skills are local developer tooling. They are not the domain product skills that must be registered in each application's capability catalog.
