---
id: rel:catalog.entity
kind: table
schema: catalog
name: entity
domain: identity
aliases: [entity, entities, canonical entity, identity row]
writers: [executor_service]
---

# catalog.entity

One row per canonical identity; kind attributes live in `catalog.entity.attributes`. `created_by_receipt_id` is required.
