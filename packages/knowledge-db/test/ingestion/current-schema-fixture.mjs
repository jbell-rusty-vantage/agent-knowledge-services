import { randomUUID } from "node:crypto";

/** Synthetic schema fixture with its own typed parents and sealed price slot. */
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
    for (const [id, kind] of [
      [provider, "organization"],
      [model, "ai_model"],
      [version, "ai_model_version"],
      [offering, "model_offering"],
    ]) {
      await client.query(
        "insert into corpus.entity(id,tenant_id,kind,slug,display_name,created_by_receipt_id) values($1,$2,$3,$4,$4,$5)",
        [id, tenantId, kind, `schema-fixture-${id}`, receipt],
      );
    }
    await client.query("insert into corpus.organization(id) values($1)", [provider]);
    await client.query("insert into corpus.ai_model(id) values($1)", [model]);
    await client.query(
      "insert into corpus.ai_model_version(id,ai_model_id,version_label) values($1,$2,'schema-fixture')",
      [version, model],
    );
    await client.query(
      "insert into corpus.model_offering(id,model_version_id,provider_entity_id,offering_key) values($1,$2,$3,'schema-fixture')",
      [offering, version, provider],
    );
    await client.query("select temporal.begin_batch((select knowledge_seq from api.knowledge_head()))");
    await client.query(
      "select temporal.assert_state($1,'model_offering_price','[2026-01-01,)'::tstzrange,'input_tokens',null,2,'USD','per_1m_input_tokens',null,'{}',null,null,'observation_bounded')",
      [offering],
    );
    await client.query("select temporal.commit_batch($1,$2,repeat('0',64),'{\"synthetic\":true}')", [
      receipt,
      offering,
    ]);
    return offering;
  });
}
