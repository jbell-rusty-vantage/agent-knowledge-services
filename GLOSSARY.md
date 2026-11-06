# Knowledge Services glossary

Shared terms for the BellLabs platform and its domain bindings. Domain vocabularies remain owned by AI Engineer and Biotech. See [domain documentation rules](docs/agents/domain.md).

| Term | Meaning |
| --- | --- |
| Application binding | Operator-reviewed association of authenticated application identity with domain endpoints, schema/policy/query pins, capabilities, custody and limits. |
| Domain knowledge service | Application-owned semantics, native queries/writes, content rules and domain agent procedures over a knowledge store. |
| Knowledge Services foundation | Reusable contracts, algorithms, application mechanisms, hosts and provider interfaces. It is not automatically a universal database. |
| Product API | Authorized composition of user/product state with knowledge operations for clients. |
| Direct read | Typed bounded read with no model or research mission. |
| Fast answer | Bounded answer over existing knowledge using approved query/retrieval profiles. |
| Explore | Bounded schema/context planning for an unfamiliar question. |
| Research | Durable external acquisition and synthesis workflow coordinated by Mission Control. |
| Evidence packet | Versioned retrieved evidence, citations, scope, omissions and abstention information; relevance is not truth. |
| Capture | Immutable observed source bytes with custody and provenance. |
| Locator | Deterministic reference to evidence inside a particular captured representation. |
| Obligation | Atomic claim or required facet that remains in coverage accounting even if unresolved. |
| Support set | Explicit conjunctive or alternative evidence structure needed to support an obligation. |
| Verification | Ordered integrity/mechanical and bounded semantic examination of registered evidence and claims. |
| Execution state | Progress or completion of work, separate from validity, admission and publication. |
| Admission | Domain policy decision permitting a particular effect or intended use of exact verified material. |
| Publication | Authorized promotion of an exact content/knowledge version to a consumer-visible release. |
| Adjudication | Immutable judgment over an assertion with independent properties, method/policy provenance and evidence. |
| World correctness | Whether a proposition is justified beyond merely faithfully quoting a source; may remain not_assessed. |
| Capture fidelity | Whether the recorded assertion faithfully represents the captured statement; does not assert scientific truth. |
| Native effect | Canonical change executed under the domain database's transaction and concurrency rules. |
| Effect identity | Stable scoped idempotency identity for one intended native effect. |
| Operational verification ledger | Knowledge Services-owned durable execution/results/delivery records in an application's PostgreSQL. |
| Domain projection | Queryable native representation of evidence/judgments linked to immutable authoritative result bytes. |
| Capability | Versioned admitted executable asset in Mission Control's application-scoped catalog. Discovery alone is not admission. |
| Skill bundle | Versioned application procedure plus references/examples; byte custody and catalog manifest are distinct. |
| Domain skill | Differentiating application-specific guidance for selecting operations, Jev recipes, evidence and completion criteria. |
| Jev recipe | Captured-state Choice/Score/Noul question with pinned labels/rubric and uncertainty/escalation policy. |
| Final application fixture | Complete consumer-to-research/content-to-verification-to-native-store scenario, prohibited until all program prerequisites pass. |
| Component evaluation | Frozen labeled behavior/quality check during implementation; distinct from the final application fixture. |

Avoid calling a sealed result "admitted", an execution success "accepted knowledge", a semantic score "proof", or a shared schema "shared application authority".

## Consumer and retrieval distinctions

- **Product GraphQL contract:** generated, approved Biotech entity-read surface for web/Expo, distinct from the input domain SDL.
- **Native agent artifact:** parameterized Cypher or a selected named/typed operation plus schema, authority, bounds and receipt semantics; never implies a GraphQL requirement.
- **Executable schema digest:** identity of generated client-facing operations/types, distinct from source SDL and migrated database state.
- **Embedding generation:** compatible model/dimensions/index/projection version; its physical store and corpus publication authority are domain decisions.
- **Owner decision gate:** recorded unanswered requirement that blocks dependent implementation; planning preapproval does not answer it.
