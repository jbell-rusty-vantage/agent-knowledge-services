-- knowledge_verification 2.3.0 / 0006_credential_use_and_protocol_receipts
-- Sprint V SV-16 (K01, K07, K09; integrator decisions 2026-10-25):
--   1. Durable single use of knowledge-operation credentials across executor restarts: one row per consumed credential
--      (tenant, issuer, jti, dispatch id, expiry). A replayed jti or a reused dispatch id refuses; expired rows are
--      purged by an explicit function (a token past its expiry is refused by K07 before it reaches this table).
--   2. The K01 `operation-receipt.v2` document of every effect (report.register, knowledge.apply), so receipt-first
--      recovery answers the protocol receipt (dispatch id, envelope digest, current caller origin) and not only the
--      native receipt row. The document must bind the component's bound effect digest for that key (design §5: the
--      bound effect digest is the plan-level digest the use decision names; EFFECT_CONFLICT otherwise). First writer
--      wins and the row is immutable. `pending_dispatch` is the outcome of an admitted marker_plus_outbox effect whose
--      target store has not acknowledged yet (Biotech graph); it is never `applied`.
-- The installer wraps this file in its transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Single-use credential nonces (K07).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.credential_use (
  tenant_id uuid not null,
  issuer text not null check (issuer ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  jti text not null check (jti ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  dispatch_id text not null check (dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  primary key (tenant_id, issuer, jti),
  unique (tenant_id, issuer, dispatch_id)
);
comment on table knowledge_verification.credential_use is
  'Consumed knowledge-operation credentials (K07): a jti is used once and a dispatch id names one credential, durably across executor restarts. expires_at is the credential expiry plus the verifier skew; purge_credential_use removes rows past it.';
create index credential_use_expiry_idx on knowledge_verification.credential_use (tenant_id, expires_at);

create or replace function knowledge_verification.consume_credential(
  p_tenant uuid, p_issuer text, p_jti text, p_dispatch_id text, p_expires_at timestamptz, p_now timestamptz default now()
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare inserted integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if p_expires_at <= p_now then
    return 'expired';
  end if;
  insert into knowledge_verification.credential_use (tenant_id, issuer, jti, dispatch_id, expires_at, consumed_at)
  values (p_tenant, p_issuer, p_jti, p_dispatch_id, p_expires_at, p_now)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 1 then
    return 'consumed';
  end if;
  if exists (select 1 from knowledge_verification.credential_use u
              where u.tenant_id = p_tenant and u.issuer = p_issuer and u.jti = p_jti) then
    return 'replay';
  end if;
  return 'dispatch_reused';
end $$;
comment on function knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz) is
  'Consume one credential: consumed | replay (jti already used) | dispatch_reused (dispatch id carried by another credential) | expired. Concurrent consumers of one jti: exactly one sees consumed.';

create or replace function knowledge_verification.purge_credential_use(p_tenant uuid, p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare removed integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  delete from knowledge_verification.credential_use u where u.tenant_id = p_tenant and u.expires_at < p_now;
  get diagnostics removed = row_count;
  return removed;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. K01 protocol receipts per effect.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.protocol_receipt (
  tenant_id uuid not null,
  effect_key text not null,
  protocol_version text not null check (protocol_version = 'ks.knowledge_operation.v2'),
  outcome text not null check (outcome in ('applied', 'noop', 'partial', 'rejected', 'pending_dispatch')),
  dispatch_id text not null check (dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  envelope_digest text not null check (envelope_digest ~ '^sha256:[0-9a-f]{64}$'),
  bound_effect_digest text not null check (bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, effect_key),
  foreign key (tenant_id, effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict
);
comment on table knowledge_verification.protocol_receipt is
  'The K01 operation-receipt.v2 document of one bound effect (the dispatch that applied or admitted it). Immutable; first writer wins; bound to the component effect digest.';
create trigger protocol_receipt_immutable before update or delete on knowledge_verification.protocol_receipt
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.record_protocol_receipt(
  p_tenant uuid, p_effect_key text, p_receipt jsonb
) returns knowledge_verification.protocol_receipt
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  bound knowledge_verification.effect;
  existing knowledge_verification.protocol_receipt;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into bound from knowledge_verification.effect e where e.tenant_id = p_tenant and e.effect_key = p_effect_key;
  if not found then
    raise exception 'EFFECT_NOT_BOUND' using errcode = 'foreign_key_violation';
  end if;
  if p_receipt -> 'effect' ->> 'effectKey' is distinct from p_effect_key
     or p_receipt -> 'handle' ->> 'tenant' is distinct from p_tenant::text then
    raise exception 'RECEIPT_SCOPE_MISMATCH' using errcode = 'check_violation';
  end if;
  -- The bound digest is the identity; the semantic payload digest is diagnostic only (it may be the envelope's digest
  -- over the intent bytes while the native path binds the plan's).
  if p_receipt -> 'effect' ->> 'boundEffectDigest' is distinct from bound.bound_effect_digest then
    raise exception 'EFFECT_CONFLICT' using errcode = 'check_violation',
      detail = 'the protocol receipt binds another effect digest than the component effect';
  end if;
  select * into existing from knowledge_verification.protocol_receipt r
   where r.tenant_id = p_tenant and r.effect_key = p_effect_key;
  if found then
    return existing;
  end if;
  insert into knowledge_verification.protocol_receipt
    (tenant_id, effect_key, protocol_version, outcome, dispatch_id, envelope_digest, bound_effect_digest, receipt, digest)
  values (p_tenant, p_effect_key, 'ks.knowledge_operation.v2', p_receipt ->> 'outcome', p_receipt -> 'effect' ->> 'dispatchId',
          p_receipt -> 'effect' ->> 'envelopeDigest', bound.bound_effect_digest, p_receipt, p_receipt ->> 'digest')
  on conflict (tenant_id, effect_key) do nothing
  returning * into existing;
  if existing.effect_key is null then
    select * into existing from knowledge_verification.protocol_receipt r
     where r.tenant_id = p_tenant and r.effect_key = p_effect_key;
  end if;
  return existing;
end $$;
comment on function knowledge_verification.record_protocol_receipt(uuid, text, jsonb) is
  'Record the K01 receipt document of a bound effect (first writer wins, immutable). Refuses a document for another tenant or key, or one that binds other bytes than the component effect (EFFECT_CONFLICT).';

do $$
declare t text;
begin
  foreach t in array array['credential_use', 'protocol_receipt'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;

grant select on knowledge_verification.credential_use, knowledge_verification.protocol_receipt to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
-- Rows are written only through the definer functions; no direct insert/update/delete grant.
grant execute on function
  knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz),
  knowledge_verification.purge_credential_use(uuid, timestamptz),
  knowledge_verification.record_protocol_receipt(uuid, text, jsonb) to knowledge_verification_writer;
