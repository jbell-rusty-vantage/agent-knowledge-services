-- knowledge_verification 2.5.0 / 0008_effect_dispatch_journal
-- Sprint OC WI-05 (OVE-167; RV-06, ADR-0060, OUTPUT-CONTRACTS section 5): recover native commits across missing
-- protocol receipts.
--   1. effect_dispatch: the immutable journal of every K01 dispatch of an effect, written in its own committed
--      transaction BEFORE native dispatch: dispatch id, per-effect sequence, envelope digest, the canonical envelope
--      document (no credential), the full caller origin document, the bound and semantic digests, the originating and
--      the current caller origin. Same dispatch id + same envelope digest is idempotent; another envelope under that id
--      refuses DISPATCH_CONFLICT; a dispatch whose bound digest or originating origin differs from the BOUND EFFECT
--      refuses EFFECT_CONFLICT before anything native runs. Uncommitted journal rows never bind the key: a refused
--      (or wrong-digest) dispatch cannot pin an effect key against a later correct dispatch.
--   2. effect_commit: which journaled dispatch committed the effect natively, written INSIDE the native transaction
--      (AI Engineer ingestion commit; Biotech admission + outbox enqueue). One per effect: a second native commit of
--      the effect refuses EFFECT_ALREADY_COMMITTED and its transaction rolls back (no duplicated native write), also
--      for two concurrent first commits (serialized per effect; a lost insert race maps to the same typed code).
--   2b. effect_dispatch_fence + abandon_effect_dispatch: a dispatch whose native transaction may still be in flight is
--      fenced before it is reported as not committed. Under the same per-effect lock as the commit stamp, the
--      abandon either finds the effect committed (answer `committed`) or records `abandoned`; record_effect_commit
--      then refuses DISPATCH_ABANDONED and the late native transaction rolls back. The fence row shares its key with
--      the `committed` fence the commit stamp writes, so the loser sees a unique conflict even under REPEATABLE READ.
--   3. record_protocol_receipt: a receipt for an effect with a native commit must name the committing dispatch and its
--      journaled envelope digest (RECEIPT_DISPATCH_MISMATCH otherwise), so a reconstructed receipt is the original
--      caller's receipt and never the recovering caller's.
-- Recovery: effect_commit present + protocol_receipt absent = native_only; Knowledge Services reconstructs the receipt
-- from the journaled dispatch and the native receipt (read back separately), records it, and never applies again.
-- The installer wraps this file in its transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The dispatch journal.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.effect_dispatch (
  tenant_id uuid not null,
  effect_key text not null check (effect_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  dispatch_id text not null check (dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  dispatch_sequence integer not null check (dispatch_sequence >= 1),
  operation text not null check (operation ~ '^[a-z][a-z0-9_.]{0,119}$'),
  envelope_digest text not null check (envelope_digest ~ '^sha256:[0-9a-f]{64}$'),
  semantic_payload_digest text not null check (semantic_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  bound_effect_digest text not null check (bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  originating_origin_digest text not null,
  caller_origin_digest text not null,
  caller_origin jsonb not null check (jsonb_typeof(caller_origin) = 'object'),
  envelope jsonb not null check (jsonb_typeof(envelope) = 'object'),
  journaled_at timestamptz not null default now(),
  primary key (tenant_id, effect_key, dispatch_id),
  unique (tenant_id, effect_key, dispatch_sequence),
  unique (tenant_id, dispatch_id),
  foreign key (tenant_id, originating_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict,
  foreign key (tenant_id, caller_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict,
  check (envelope ->> 'dispatchId' = dispatch_id),
  check (envelope -> 'effect' ->> 'effectKey' = effect_key)
);
comment on table knowledge_verification.effect_dispatch is
  'Immutable journal of every K01 dispatch of an effect (2.5.0), written before native dispatch: the original request, its caller origin and digests. The source of a reconstructed protocol receipt.';
create trigger effect_dispatch_immutable before update or delete on knowledge_verification.effect_dispatch
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.journal_effect_dispatch(
  p_tenant uuid, p_effect_key text, p_dispatch_id text, p_operation text, p_envelope_digest text,
  p_semantic_payload_digest text, p_bound_effect_digest text, p_originating_origin_digest text,
  p_caller_origin_digest text, p_caller_origin jsonb, p_envelope jsonb
) returns knowledge_verification.effect_dispatch
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  existing knowledge_verification.effect_dispatch;
  bound knowledge_verification.effect;
  next_sequence integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  -- One journal writer per effect at a time: the sequence is dense.
  perform pg_advisory_xact_lock(hashtextextended('knowledge_verification.effect_dispatch/' || p_tenant::text || '/' || p_effect_key, 0));
  select * into existing from knowledge_verification.effect_dispatch d
   where d.tenant_id = p_tenant and d.dispatch_id = p_dispatch_id;
  if found then
    if existing.effect_key <> p_effect_key or existing.envelope_digest <> p_envelope_digest then
      raise exception 'DISPATCH_CONFLICT' using errcode = 'unique_violation',
        detail = 'the dispatch id is journaled with another envelope';
    end if;
    return existing;
  end if;
  select * into bound from knowledge_verification.effect e where e.tenant_id = p_tenant and e.effect_key = p_effect_key;
  -- Only the bound effect (written by a native commit or a registration) binds the key; earlier uncommitted journal
  -- rows are evidence of attempts, never authority, so a refused dispatch cannot poison the key.
  if found and (bound.bound_effect_digest <> p_bound_effect_digest or bound.originating_origin_digest <> p_originating_origin_digest) then
    raise exception 'EFFECT_CONFLICT' using errcode = 'unique_violation',
      detail = 'the effect key is bound to other bytes or another originating origin';
  end if;
  select coalesce(max(d.dispatch_sequence), 0) + 1 into next_sequence from knowledge_verification.effect_dispatch d
   where d.tenant_id = p_tenant and d.effect_key = p_effect_key;
  insert into knowledge_verification.effect_dispatch
    (tenant_id, effect_key, dispatch_id, dispatch_sequence, operation, envelope_digest, semantic_payload_digest,
     bound_effect_digest, originating_origin_digest, caller_origin_digest, caller_origin, envelope)
  values (p_tenant, p_effect_key, p_dispatch_id, next_sequence, p_operation, p_envelope_digest, p_semantic_payload_digest,
          p_bound_effect_digest, p_originating_origin_digest, p_caller_origin_digest, p_caller_origin, p_envelope)
  returning * into existing;
  return existing;
end $$;
comment on function knowledge_verification.journal_effect_dispatch(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb) is
  'Journal one K01 dispatch before native dispatch (2.5.0): idempotent for the same dispatch id and envelope digest; DISPATCH_CONFLICT for another envelope under that id; EFFECT_CONFLICT when the bound digest or originating origin differs from the bound effect. Uncommitted journal rows never bind the key.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The native commit stamp.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.effect_commit (
  tenant_id uuid not null,
  effect_key text not null,
  dispatch_id text not null,
  native_ref jsonb not null check (jsonb_typeof(native_ref) = 'object'),
  committed_at timestamptz not null default now(),
  primary key (tenant_id, effect_key),
  foreign key (tenant_id, effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict,
  foreign key (tenant_id, effect_key, dispatch_id) references knowledge_verification.effect_dispatch (tenant_id, effect_key, dispatch_id) on delete restrict
);
comment on table knowledge_verification.effect_commit is
  'Which journaled dispatch committed an effect natively (2.5.0), written inside the native transaction; native_ref locates the native receipt (AI Engineer ingestion receipt id, Biotech outbox dispatch id). One per effect.';
create trigger effect_commit_immutable before update or delete on knowledge_verification.effect_commit
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.effect_dispatch_fence (
  tenant_id uuid not null,
  effect_key text not null,
  dispatch_id text not null,
  state text not null check (state in ('committed', 'abandoned')),
  fenced_at timestamptz not null default now(),
  primary key (tenant_id, effect_key, dispatch_id),
  foreign key (tenant_id, effect_key, dispatch_id) references knowledge_verification.effect_dispatch (tenant_id, effect_key, dispatch_id) on delete restrict
);
comment on table knowledge_verification.effect_dispatch_fence is
  'One terminal fence per journaled dispatch (2.5.0): committed (written with the native commit stamp) or abandoned (written before a refused dispatch is reported not committed). Immutable; the first writer decides.';
create trigger effect_dispatch_fence_immutable before update or delete on knowledge_verification.effect_dispatch_fence
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.record_effect_commit(
  p_tenant uuid, p_effect_key text, p_dispatch_id text, p_native_ref jsonb
) returns knowledge_verification.effect_commit
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  existing knowledge_verification.effect_commit;
  journaled knowledge_verification.effect_dispatch;
  bound knowledge_verification.effect;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into journaled from knowledge_verification.effect_dispatch d
   where d.tenant_id = p_tenant and d.effect_key = p_effect_key and d.dispatch_id = p_dispatch_id;
  if not found then
    raise exception 'DISPATCH_NOT_JOURNALED' using errcode = 'foreign_key_violation',
      detail = 'journal the dispatch before its native transaction';
  end if;
  select * into bound from knowledge_verification.effect e where e.tenant_id = p_tenant and e.effect_key = p_effect_key;
  if not found then
    raise exception 'EFFECT_NOT_BOUND' using errcode = 'foreign_key_violation';
  end if;
  if bound.bound_effect_digest <> journaled.bound_effect_digest then
    raise exception 'EFFECT_CONFLICT' using errcode = 'unique_violation',
      detail = 'the native transaction bound other bytes than the journaled dispatch';
  end if;
  -- Two concurrent first commits: serialize per effect (a row lock cannot lock a row that does not exist yet). A
  -- REPEATABLE READ native transaction may still not see the winner's row; its insert then loses the primary key race
  -- and gets the same typed refusal below, never a raw unique violation.
  perform pg_advisory_xact_lock(hashtextextended('knowledge_verification.effect_commit/' || p_tenant::text || '/' || p_effect_key, 0));
  select * into existing from knowledge_verification.effect_commit c
   where c.tenant_id = p_tenant and c.effect_key = p_effect_key;
  if found then
    if existing.dispatch_id = p_dispatch_id and existing.native_ref = p_native_ref then
      return existing;
    end if;
    raise exception 'EFFECT_ALREADY_COMMITTED' using errcode = 'unique_violation',
      detail = 'the effect is already committed natively by another dispatch';
  end if;
  -- The dispatch's terminal fence: an abandoned dispatch (reported not committed) can never commit later.
  begin
    insert into knowledge_verification.effect_dispatch_fence (tenant_id, effect_key, dispatch_id, state)
    values (p_tenant, p_effect_key, p_dispatch_id, 'committed');
  exception when unique_violation then
    raise exception 'DISPATCH_ABANDONED' using errcode = 'unique_violation',
      detail = 'the dispatch was abandoned (reported not committed); its native transaction must roll back';
  end;
  begin
    insert into knowledge_verification.effect_commit (tenant_id, effect_key, dispatch_id, native_ref)
    values (p_tenant, p_effect_key, p_dispatch_id, p_native_ref)
    returning * into existing;
  exception when unique_violation then
    raise exception 'EFFECT_ALREADY_COMMITTED' using errcode = 'unique_violation',
      detail = 'a concurrent dispatch committed the effect natively first';
  end;
  return existing;
end $$;
comment on function knowledge_verification.record_effect_commit(uuid, text, text, jsonb) is
  'Stamp the native commit of an effect with its journaled dispatch, on the native transaction''s own connection (2.5.0). A second native commit of the effect raises EFFECT_ALREADY_COMMITTED and an abandoned dispatch DISPATCH_ABANDONED (its transaction rolls back).';

create or replace function knowledge_verification.abandon_effect_dispatch(
  p_tenant uuid, p_effect_key text, p_dispatch_id text
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  fenced text;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if not exists (select 1 from knowledge_verification.effect_dispatch d
                  where d.tenant_id = p_tenant and d.effect_key = p_effect_key and d.dispatch_id = p_dispatch_id) then
    raise exception 'DISPATCH_NOT_JOURNALED' using errcode = 'foreign_key_violation';
  end if;
  -- The commit stamp's lock: a native transaction holding it (stamped, COMMIT in flight) finishes first.
  perform pg_advisory_xact_lock(hashtextextended('knowledge_verification.effect_commit/' || p_tenant::text || '/' || p_effect_key, 0));
  if exists (select 1 from knowledge_verification.effect_commit c where c.tenant_id = p_tenant and c.effect_key = p_effect_key) then
    return 'committed';
  end if;
  insert into knowledge_verification.effect_dispatch_fence (tenant_id, effect_key, dispatch_id, state)
  values (p_tenant, p_effect_key, p_dispatch_id, 'abandoned')
  on conflict (tenant_id, effect_key, dispatch_id) do nothing;
  select f.state into fenced from knowledge_verification.effect_dispatch_fence f
   where f.tenant_id = p_tenant and f.effect_key = p_effect_key and f.dispatch_id = p_dispatch_id;
  return fenced;
end $$;
comment on function knowledge_verification.abandon_effect_dispatch(uuid, text, text) is
  'Fence a journaled dispatch before reporting it not committed (2.5.0): committed when the effect is already committed natively (a commit in flight is waited for), abandoned otherwise; an abandoned dispatch can never commit.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Protocol receipts name the committing dispatch.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function knowledge_verification.record_protocol_receipt(
  p_tenant uuid, p_effect_key text, p_receipt jsonb
) returns knowledge_verification.protocol_receipt
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  bound knowledge_verification.effect;
  committed knowledge_verification.effect_commit;
  journaled knowledge_verification.effect_dispatch;
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
  if p_receipt -> 'effect' ->> 'boundEffectDigest' is distinct from bound.bound_effect_digest then
    raise exception 'EFFECT_CONFLICT' using errcode = 'check_violation',
      detail = 'the protocol receipt binds another effect digest than the component effect';
  end if;
  select * into existing from knowledge_verification.protocol_receipt r
   where r.tenant_id = p_tenant and r.effect_key = p_effect_key;
  if found then
    return existing;
  end if;
  -- 2.5.0: an effect committed natively by a journaled dispatch is acknowledged by that dispatch's receipt only.
  select * into committed from knowledge_verification.effect_commit c where c.tenant_id = p_tenant and c.effect_key = p_effect_key;
  if found then
    select * into journaled from knowledge_verification.effect_dispatch d
     where d.tenant_id = p_tenant and d.effect_key = p_effect_key and d.dispatch_id = committed.dispatch_id;
    if p_receipt -> 'effect' ->> 'dispatchId' is distinct from committed.dispatch_id
       or p_receipt -> 'effect' ->> 'envelopeDigest' is distinct from journaled.envelope_digest then
      raise exception 'RECEIPT_DISPATCH_MISMATCH' using errcode = 'check_violation',
        detail = 'the protocol receipt of a natively committed effect names another dispatch than the committing one';
    end if;
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
  'Record the K01 receipt document of a bound effect (first writer wins, immutable). Refuses another tenant or key, other bytes than the component effect (EFFECT_CONFLICT) and, for a natively committed effect, a receipt that names another dispatch or envelope than the committing one (RECEIPT_DISPATCH_MISMATCH, 2.5.0).';

-- ---------------------------------------------------------------------------------------------------------------
-- Row security and grants (2.5.0). Rows are written only through the definer functions.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['effect_dispatch', 'effect_commit', 'effect_dispatch_fence'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;
grant select on knowledge_verification.effect_dispatch, knowledge_verification.effect_commit,
  knowledge_verification.effect_dispatch_fence to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
revoke all on function
  knowledge_verification.journal_effect_dispatch(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb),
  knowledge_verification.record_effect_commit(uuid, text, text, jsonb),
  knowledge_verification.abandon_effect_dispatch(uuid, text, text),
  knowledge_verification.record_protocol_receipt(uuid, text, jsonb) from public;
grant execute on function
  knowledge_verification.journal_effect_dispatch(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb),
  knowledge_verification.record_effect_commit(uuid, text, text, jsonb),
  knowledge_verification.abandon_effect_dispatch(uuid, text, text),
  knowledge_verification.record_protocol_receipt(uuid, text, jsonb) to knowledge_verification_writer;
