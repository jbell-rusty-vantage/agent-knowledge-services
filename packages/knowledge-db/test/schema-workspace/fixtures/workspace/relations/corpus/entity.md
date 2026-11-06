---
id: rel:corpus.entity
kind: table
schema: corpus
name: entity
domain: identity
aliases: [entity, entities, canonical entity, identity row]
writers: [executor_service]
---

# corpus.entity

One row per canonical identity; typed attributes live in `corpus.<kind>`. `created_by_receipt_id` is required.
