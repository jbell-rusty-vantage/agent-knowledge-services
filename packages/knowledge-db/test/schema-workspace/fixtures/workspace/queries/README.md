# Named queries (fixture)

| name | role | params |
|---|---|---|
| entity.resolve | app_reader | text |
| entity.card | app_reader | entity_id |
| entity.at | app_reader | entity_id, at?, k? |
| entity.what_changed | app_reader | entity_id, k_from, k_to |
| facts.history_for_stream | pipeline_agent | entity_id, stream_kind, scope_key?, limit?, offset? |
| vocab.stream_kind | pipeline_agent | — |
| knowledge.head | app_reader | — |
