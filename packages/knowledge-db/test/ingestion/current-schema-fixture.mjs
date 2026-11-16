import { randomUUID } from "node:crypto";

/**
 * Synthetic schema fixture on the current AI Engineer schema (catalog identities with validated attributes, one
 * `offering_price` series keyed the way the lab's loader keys them). Returns the offering entity id.
 */
export async function seedPriceSlot(db, tenantId) {
  return db.transaction({ tenantId }, async (client) => {
    const [provider, model, version, offering, intent, receipt] = Array.from({ length: 6 }, () => randomUUID());
    await client.query(
      "insert into orchestration.operation_intent(id,tenant_id,intent_type,schema_version,payload,preconditions,idempotency_key,approval_state,policy_decision) values($1,$3,'knowledge_ingestion',1,'{\"synthetic\":true}','{}',$2,'approved','{\"mode\":\"synthetic-schema-fixture\"}')",
      [intent, offering, tenantId],
    );
    await client.query(
      "insert into orchestration.operation_receipt(id,intent_id,executor_version,outcome,changes_summary) values($1,$2,'synthetic-schema-fixture/1','applied','{}')",
      [receipt, intent],
    );
    for (const [id, kind, attributes] of [
      [provider, "organization", {}],
      [model, "ai_model", {}],
      [version, "ai_model_version", { version_label: "schema-fixture" }],
      [offering, "model_offering", { offering_key: `schema-fixture-${offering}` }],
    ]) {
      await client.query(
        "insert into catalog.entity(id,tenant_id,kind,slug,display_name,attributes,created_by_receipt_id) values($1,$2,$3,$4,$4,$5::jsonb,$6)",
        [id, tenantId, kind, `schema-fixture-${id}`, JSON.stringify(attributes), receipt],
      );
    }
    await client.query("select temporal.begin_batch((select knowledge_seq from api.knowledge_head()))");
    await client.query(
      "select temporal.assert_state($1,'offering_price','[2026-01-01,)'::tstzrange,'input_tokens|fast||',null,2,'USD','USD_per_1M_tokens',null,'{\"meter\":\"input_tokens\",\"tier\":\"fast\"}',null,null,'observation_bounded')",
      [offering],
    );
    await client.query("select temporal.commit_batch($1,$2,repeat('0',64),'{\"synthetic\":true}')", [
      receipt,
      offering,
    ]);
    return offering;
  });
}
