---
id: rel:temporal.segment
kind: table
schema: temporal
name: segment
domain: temporal-facts
aliases: [fact, temporal fact, state segment, interval fact]
writers: []
---

# temporal.segment

A fact on a stream: world interval `valid_during`, knowledge interval `[k_from, k_to)`.
No direct DML for any role; asserted through `temporal.assert_state` inside an open batch.
