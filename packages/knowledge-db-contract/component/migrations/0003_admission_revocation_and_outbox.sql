-- knowledge_verification 2.0.0 / 0003_admission_revocation_and_outbox
-- Exact-use decisions and qualified human review, the dependency graph and invalidation closure, the per-tenant
-- authoritative revocation epoch, effect receipts and the cross-store dispatch outbox (design §7, V06/V08/V12).

-- ---------------------------------------------------------------------------------------------------------------
-- Reviewer grants and adjudications: a human signs exact bindings through a qualified grant; MC Human Task
-- completion alone never grants a domain effect (E06).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.reviewer_grant (
  tenant_id uuid not null,
  grant_id uuid not null default gen_random_uuid(),
  reviewer_id text not null,
  scope jsonb not null default '{}'::jsonb,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, grant_id),
  check (revoked_at is null or revoked_at >= granted_at)
);
comment on table knowledge_verification.reviewer_grant is 'Qualified reviewer grants; an adjudication requires an active grant at decision time.';
create index reviewer_grant_reviewer_idx on knowledge_verification.reviewer_grant (tenant_id, reviewer_id) where revoked_at is null;

create or replace function knowledge_verification.reviewer_grant_only_revocable() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD' using errcode = 'integrity_constraint_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.grant_id <> old.grant_id or new.reviewer_id <> old.reviewer_id
     or new.scope <> old.scope or new.granted_by <> old.granted_by or new.granted_at <> old.granted_at
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'GRANT_ONLY_REVOCABLE' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger reviewer_grant_guard before update or delete on knowledge_verification.reviewer_grant
  for each row execute function knowledge_verification.reviewer_grant_only_revocable();

create table knowledge_verification.adjudication (
  tenant_id uuid not null,
  adjudication_id text not null,
  subject_kind text not null check (subject_kind in ('assertion', 'support_set', 'report', 'use_decision', 'effect')),
  subject_id text not null,
  subject_digest text not null check (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  bound_effect_digest text check (bound_effect_digest is null or bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  reviewer_id text not null,
  decision text not null check (decision in ('approve', 'hold', 'reject')),
  rationale text not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  decided_at timestamptz not null default now(),
  primary key (tenant_id, adjudication_id),
  unique (tenant_id, digest)
);
comment on table knowledge_verification.adjudication is
  'Attributable reviewer decisions over exact subject digests (and the exact effect digest when reviewing an effect). Append-only; a later decision supersedes by reference.';
create trigger adjudication_immutable before update or delete on knowledge_verification.adjudication
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.adjudication_requires_grant() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if not exists (
    select 1 from knowledge_verification.reviewer_grant g
     where g.tenant_id = new.tenant_id and g.reviewer_id = new.reviewer_id
       and g.granted_at <= new.decided_at and (g.revoked_at is null or g.revoked_at > new.decided_at)
  ) then
    raise exception 'REVIEWER_NOT_QUALIFIED' using errcode = 'insufficient_privilege',
      detail = format('reviewer %s holds no active grant at %s', new.reviewer_id, new.decided_at);
  end if;
  return new;
end $$;
create trigger adjudication_grant before insert on knowledge_verification.adjudication
  for each row execute function knowledge_verification.adjudication_requires_grant();

-- ---------------------------------------------------------------------------------------------------------------
-- Revocation epoch: one authoritative per-tenant high-water mark. Advanced by explicit correction/revocation,
-- source-origin regrouping or rubric change; admission requires processed_epoch >= authoritative_epoch.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.revocation_epoch (
  tenant_id uuid primary key,
  epoch bigint not null default 0 check (epoch >= 0),
  advanced_at timestamptz not null default now(),
  reason text not null default 'initial'
);
comment on table knowledge_verification.revocation_epoch is 'Authoritative per-scope revocation high-water mark (design §7).';

create or replace function knowledge_verification.current_revocation_epoch(p_tenant uuid) returns bigint
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select e.epoch from knowledge_verification.revocation_epoch e where e.tenant_id = p_tenant), 0)
   where p_tenant = knowledge_verification.current_tenant_id();
$$;

create or replace function knowledge_verification.advance_revocation_epoch(p_tenant uuid, p_reason text) returns bigint
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare next_epoch bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = 'invalid_parameter_value';
  end if;
  insert into knowledge_verification.revocation_epoch (tenant_id, epoch, reason) values (p_tenant, 1, p_reason)
  on conflict (tenant_id) do update set epoch = knowledge_verification.revocation_epoch.epoch + 1, advanced_at = now(), reason = excluded.reason
  returning epoch into next_epoch;
  return next_epoch;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Dependency graph and invalidation: capture -> fragment -> assertion/support -> report -> use/effect.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.dependency_edge (
  tenant_id uuid not null,
  from_kind text not null check (from_kind in ('capture', 'fragment', 'assertion', 'support_set', 'report', 'use_decision', 'effect')),
  from_id text not null,
  to_kind text not null check (to_kind in ('capture', 'fragment', 'assertion', 'support_set', 'report', 'use_decision', 'effect')),
  to_id text not null,
  edge_kind text not null check (edge_kind in ('captured_from', 'extracted_from', 'supports', 'contradicts', 'premise_of', 'occurs_in', 'decided_from', 'applied_from')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, from_kind, from_id, to_kind, to_id, edge_kind)
);
comment on table knowledge_verification.dependency_edge is 'Append-only dependency edges used by invalidation closure; from depends on to.';
create index dependency_edge_to_idx on knowledge_verification.dependency_edge (tenant_id, to_kind, to_id);
create trigger dependency_edge_immutable before update or delete on knowledge_verification.dependency_edge
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.invalidation (
  tenant_id uuid not null,
  invalidation_id uuid not null default gen_random_uuid(),
  corrected_kind text not null check (corrected_kind in ('capture', 'fragment', 'assertion', 'support_set', 'report', 'rubric', 'origin_family')),
  corrected_id text not null,
  reason text not null,
  epoch bigint not null check (epoch >= 1),
  created_at timestamptz not null default now(),
  closure_processed_at timestamptz,
  primary key (tenant_id, invalidation_id)
);
comment on table knowledge_verification.invalidation is
  'A known correction/revocation at the epoch it advanced; closure_processed_at is set once every affected record is listed.';

create table knowledge_verification.invalidation_affected (
  tenant_id uuid not null,
  invalidation_id uuid not null,
  affected_kind text not null check (affected_kind in ('fragment', 'assertion', 'support_set', 'report', 'use_decision', 'effect')),
  affected_id text not null,
  primary key (tenant_id, invalidation_id, affected_kind, affected_id),
  foreign key (tenant_id, invalidation_id) references knowledge_verification.invalidation (tenant_id, invalidation_id) on delete restrict
);
create trigger invalidation_affected_immutable before update or delete on knowledge_verification.invalidation_affected
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.invalidation_only_closes() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD' using errcode = 'integrity_constraint_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.invalidation_id <> old.invalidation_id or new.corrected_kind <> old.corrected_kind
     or new.corrected_id <> old.corrected_id or new.reason <> old.reason or new.epoch <> old.epoch or new.created_at <> old.created_at
     or (old.closure_processed_at is not null and new.closure_processed_at is distinct from old.closure_processed_at) then
    raise exception 'INVALIDATION_ONLY_CLOSES' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger invalidation_guard before update or delete on knowledge_verification.invalidation
  for each row execute function knowledge_verification.invalidation_only_closes();

create or replace function knowledge_verification.record_invalidation(
  p_tenant uuid, p_corrected_kind text, p_corrected_id text, p_reason text
) returns knowledge_verification.invalidation
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare rec knowledge_verification.invalidation; next_epoch bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  next_epoch := knowledge_verification.advance_revocation_epoch(p_tenant, format('%s:%s %s', p_corrected_kind, p_corrected_id, p_reason));
  insert into knowledge_verification.invalidation (tenant_id, corrected_kind, corrected_id, reason, epoch)
  values (p_tenant, p_corrected_kind, p_corrected_id, p_reason, next_epoch) returning * into rec;
  return rec;
end $$;
comment on function knowledge_verification.record_invalidation(uuid, text, text, text) is
  'Records a correction and advances the authoritative epoch in one statement; closure listing is the application''s next step.';

-- ---------------------------------------------------------------------------------------------------------------
-- Use decisions: exact-use admission bound to report revision, assertion qualifiers, selected support set, tenant,
-- use/audience, policy/rubric and expiry; checked at admission under the native transaction (design §7).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.use_decision (
  tenant_id uuid not null,
  use_decision_id text not null,
  schema_version text not null check (schema_version = 'research-core.use_decision.v2'),
  subject_kind text not null check (subject_kind in ('assertion', 'report')),
  subject_id text not null,
  subject_digest text not null check (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  run_id uuid not null,
  bound_effect_digest text not null check (bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  use_name text not null,
  audience text not null,
  disposition text not null check (disposition in ('admitted', 'held', 'rejected')),
  conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  policy_ref text not null,
  rubric_ref text not null,
  qualifiers_digest text not null check (qualifiers_digest ~ '^sha256:[0-9a-f]{64}$'),
  support_set_id text,
  revocation_epoch bigint not null check (revocation_epoch >= 0),
  expires_at timestamptz,
  reviewer_adjudication_id text,
  supersedes_use_decision_id text,
  record jsonb not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  decided_at timestamptz not null default now(),
  primary key (tenant_id, use_decision_id),
  unique (tenant_id, digest),
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  foreign key (tenant_id, support_set_id) references knowledge_verification.support_set (tenant_id, support_set_id) on delete restrict,
  foreign key (tenant_id, reviewer_adjudication_id) references knowledge_verification.adjudication (tenant_id, adjudication_id) on delete restrict,
  foreign key (tenant_id, supersedes_use_decision_id) references knowledge_verification.use_decision (tenant_id, use_decision_id) on delete restrict,
  check (supersedes_use_decision_id is null or supersedes_use_decision_id <> use_decision_id)
);
comment on table knowledge_verification.use_decision is
  'UseDecision (design §3/§7): admitted/held/rejected for one exact effect digest, use and audience; append-only, superseded by reference.';
create index use_decision_subject_idx on knowledge_verification.use_decision (tenant_id, subject_kind, subject_id);
create trigger use_decision_immutable before update or delete on knowledge_verification.use_decision
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.use_decision_run_sealed() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare run_state text; adj knowledge_verification.adjudication;
begin
  select r.state into run_state from knowledge_verification.verification_run r
    where r.tenant_id = new.tenant_id and r.run_id = new.run_id;
  if run_state is distinct from 'sealed' then
    raise exception 'RUN_NOT_SEALED' using errcode = 'integrity_constraint_violation',
      detail = 'a use decision references a sealed verification snapshot';
  end if;
  if new.reviewer_adjudication_id is not null then
    select * into adj from knowledge_verification.adjudication a
      where a.tenant_id = new.tenant_id and a.adjudication_id = new.reviewer_adjudication_id;
    if adj.bound_effect_digest is distinct from new.bound_effect_digest then
      raise exception 'REVIEW_BINDING_MISMATCH' using errcode = 'integrity_constraint_violation',
        detail = 'the reviewer signed a different effect digest than this decision admits';
    end if;
    if new.disposition = 'admitted' and adj.decision <> 'approve' then
      raise exception 'REVIEW_NOT_APPROVED' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  return new;
end $$;
create trigger use_decision_guard before insert on knowledge_verification.use_decision
  for each row execute function knowledge_verification.use_decision_run_sealed();

create or replace function knowledge_verification.admit_exact_use(
  p_tenant uuid, p_use_decision_id text, p_bound_effect_digest text, p_processed_epoch bigint, p_now timestamptz default now()
) returns table (outcome text, reason text, authoritative_epoch bigint)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare d knowledge_verification.use_decision; auth bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  -- Lock the epoch row so a concurrent advance serializes against this admission.
  insert into knowledge_verification.revocation_epoch (tenant_id, epoch, reason) values (p_tenant, 0, 'initial') on conflict do nothing;
  select e.epoch into auth from knowledge_verification.revocation_epoch e where e.tenant_id = p_tenant for share;
  select * into d from knowledge_verification.use_decision u where u.tenant_id = p_tenant and u.use_decision_id = p_use_decision_id;
  if not found then
    return query select 'rejected', 'DECISION_NOT_FOUND', auth; return;
  end if;
  if exists (select 1 from knowledge_verification.use_decision s where s.tenant_id = p_tenant and s.supersedes_use_decision_id = d.use_decision_id) then
    return query select 'held', 'STALE_DECISION', auth; return;
  end if;
  if d.disposition <> 'admitted' then
    return query select d.disposition, 'DECISION_' || upper(d.disposition), auth; return;
  end if;
  if d.bound_effect_digest <> p_bound_effect_digest then
    return query select 'rejected', 'EFFECT_DIGEST_MISMATCH', auth; return;
  end if;
  if d.expires_at is not null and d.expires_at <= p_now then
    return query select 'held', 'DECISION_EXPIRED', auth; return;
  end if;
  if p_processed_epoch is null or p_processed_epoch < auth then
    return query select 'held', 'REVOCATION_EPOCH_STALE', auth; return;
  end if;
  if exists (
    select 1 from knowledge_verification.invalidation i
     where i.tenant_id = p_tenant and i.epoch > d.revocation_epoch and i.closure_processed_at is null
  ) then
    return query select 'held', 'INVALIDATION_CLOSURE_INCOMPLETE', auth; return;
  end if;
  if exists (
    select 1 from knowledge_verification.invalidation_affected a
     where a.tenant_id = p_tenant and a.affected_kind = 'use_decision' and a.affected_id = d.use_decision_id
  ) then
    return query select 'rejected', 'DECISION_INVALIDATED', auth; return;
  end if;
  return query select 'admitted', 'OK', auth;
end $$;
comment on function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz) is
  'Exact-use check under the epoch lock: admitted only for the exact effect digest, unexpired, not superseded/invalidated, processed_epoch >= authoritative and closure complete; authority unavailable means the caller holds.';

-- ---------------------------------------------------------------------------------------------------------------
-- Effect receipts: one per effect; idempotent re-record of identical bytes, conflict otherwise.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.effect_receipt (
  tenant_id uuid not null,
  effect_key text not null,
  outcome text not null check (outcome in ('applied', 'noop', 'partial', 'rejected')),
  native_receipt_ref jsonb not null,
  affected_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(affected_refs) = 'array'),
  concurrency_before text,
  concurrency_after text,
  processed_epoch bigint not null check (processed_epoch >= 0),
  item_outcomes jsonb not null default '[]'::jsonb check (jsonb_typeof(item_outcomes) = 'array'),
  use_decision_id text,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  primary key (tenant_id, effect_key),
  foreign key (tenant_id, effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict,
  foreign key (tenant_id, use_decision_id) references knowledge_verification.use_decision (tenant_id, use_decision_id) on delete restrict
);
comment on table knowledge_verification.effect_receipt is 'OperationReceipt per bound effect; the lookup target for receipt-first recovery.';
create trigger effect_receipt_immutable before update or delete on knowledge_verification.effect_receipt
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.record_effect_receipt(
  p_tenant uuid, p_effect_key text, p_outcome text, p_native_receipt_ref jsonb, p_affected_refs jsonb,
  p_concurrency_before text, p_concurrency_after text, p_processed_epoch bigint, p_item_outcomes jsonb,
  p_use_decision_id text, p_digest text
) returns knowledge_verification.effect_receipt
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare existing knowledge_verification.effect_receipt;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into existing from knowledge_verification.effect_receipt r where r.tenant_id = p_tenant and r.effect_key = p_effect_key for share;
  if found then
    if existing.digest <> p_digest then
      raise exception 'RECEIPT_CONFLICT' using errcode = 'unique_violation', detail = 'a different receipt already exists for this effect';
    end if;
    return existing;
  end if;
  insert into knowledge_verification.effect_receipt
    (tenant_id, effect_key, outcome, native_receipt_ref, affected_refs, concurrency_before, concurrency_after, processed_epoch, item_outcomes, use_decision_id, digest)
  values (p_tenant, p_effect_key, p_outcome, p_native_receipt_ref, coalesce(p_affected_refs, '[]'::jsonb), p_concurrency_before, p_concurrency_after,
          p_processed_epoch, coalesce(p_item_outcomes, '[]'::jsonb), p_use_decision_id, p_digest)
  returning * into existing;
  return existing;
exception when unique_violation then
  select * into existing from knowledge_verification.effect_receipt r where r.tenant_id = p_tenant and r.effect_key = p_effect_key;
  if existing.digest <> p_digest then
    raise exception 'RECEIPT_CONFLICT' using errcode = 'unique_violation';
  end if;
  return existing;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Dispatch outbox: cross-store delivery (Biotech graph projection, acknowledgments). PostgreSQL and Neo4j are not
-- one transaction; the outbox row is the durable intent, the acknowledgment carries the native marker digest.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.dispatch_outbox (
  tenant_id uuid not null,
  dispatch_id text not null,
  effect_key text not null,
  target_binding text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'dispatched', 'acknowledged', 'failed', 'revoked')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  dispatched_at timestamptz,
  acknowledged_at timestamptz,
  ack_digest text check (ack_digest is null or ack_digest ~ '^sha256:[0-9a-f]{64}$'),
  last_error text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, dispatch_id),
  foreign key (tenant_id, effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict,
  check ((state = 'acknowledged') = (acknowledged_at is not null and ack_digest is not null))
);
comment on table knowledge_verification.dispatch_outbox is 'Durable cross-store delivery intents; acknowledged only with the target''s native marker digest.';
create index dispatch_outbox_pending_idx on knowledge_verification.dispatch_outbox (tenant_id, available_at) where state in ('pending', 'dispatched');

create or replace function knowledge_verification.claim_dispatches(p_tenant uuid, p_limit integer, p_now timestamptz default now())
returns setof knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  return query
    update knowledge_verification.dispatch_outbox o
       set state = 'dispatched', attempts = o.attempts + 1, dispatched_at = p_now, available_at = p_now + interval '60 seconds'
     where (o.tenant_id, o.dispatch_id) in (
       select c.tenant_id, c.dispatch_id from knowledge_verification.dispatch_outbox c
        where c.tenant_id = p_tenant and c.state in ('pending', 'dispatched') and c.available_at <= p_now
        order by c.available_at
        limit greatest(1, least(p_limit, 100))
        for update skip locked)
    returning o.*;
end $$;

create or replace function knowledge_verification.acknowledge_dispatch(p_tenant uuid, p_dispatch_id text, p_ack_digest text, p_now timestamptz default now())
returns knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.dispatch_outbox;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into row_ from knowledge_verification.dispatch_outbox o where o.tenant_id = p_tenant and o.dispatch_id = p_dispatch_id for update;
  if not found then
    raise exception 'DISPATCH_NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if row_.state = 'acknowledged' then
    if row_.ack_digest <> p_ack_digest then
      raise exception 'ACK_CONFLICT' using errcode = 'unique_violation', detail = 'duplicate acknowledgment with a different marker digest';
    end if;
    return row_;  -- duplicate delivery of the same acknowledgment is a no-op
  end if;
  if row_.state = 'revoked' then
    raise exception 'DISPATCH_REVOKED' using errcode = 'integrity_constraint_violation',
      detail = 'the decision was revoked while in transit; the target must not report it as current';
  end if;
  update knowledge_verification.dispatch_outbox set state = 'acknowledged', acknowledged_at = p_now, ack_digest = p_ack_digest, last_error = null
   where tenant_id = p_tenant and dispatch_id = p_dispatch_id returning * into row_;
  return row_;
end $$;

create or replace function knowledge_verification.fail_dispatch(p_tenant uuid, p_dispatch_id text, p_error text, p_retry_after interval default interval '5 minutes')
returns knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.dispatch_outbox;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  update knowledge_verification.dispatch_outbox
     set state = case when attempts >= 8 then 'failed' else 'pending' end, last_error = left(p_error, 2000), available_at = now() + p_retry_after
   where tenant_id = p_tenant and dispatch_id = p_dispatch_id and state = 'dispatched' returning * into row_;
  if not found then
    raise exception 'DISPATCH_NOT_CLAIMED' using errcode = 'no_data_found';
  end if;
  return row_;
end $$;

create or replace function knowledge_verification.revoke_pending_dispatches(p_tenant uuid, p_effect_key text) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare n integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  update knowledge_verification.dispatch_outbox set state = 'revoked'
   where tenant_id = p_tenant and effect_key = p_effect_key and state in ('pending', 'dispatched');
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare t text;
begin
  foreach t in array array['reviewer_grant', 'adjudication', 'revocation_epoch', 'dependency_edge', 'invalidation', 'invalidation_affected',
                           'use_decision', 'effect_receipt', 'dispatch_outbox'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;

grant select on knowledge_verification.reviewer_grant, knowledge_verification.adjudication, knowledge_verification.revocation_epoch,
  knowledge_verification.dependency_edge, knowledge_verification.invalidation, knowledge_verification.invalidation_affected,
  knowledge_verification.use_decision, knowledge_verification.effect_receipt, knowledge_verification.dispatch_outbox to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant insert on knowledge_verification.reviewer_grant to knowledge_verification_reviewer;
grant update (revoked_at) on knowledge_verification.reviewer_grant to knowledge_verification_reviewer;
grant insert on knowledge_verification.adjudication to knowledge_verification_reviewer;
grant insert on knowledge_verification.dependency_edge, knowledge_verification.invalidation_affected, knowledge_verification.use_decision,
  knowledge_verification.dispatch_outbox to knowledge_verification_writer;
grant update (closure_processed_at) on knowledge_verification.invalidation to knowledge_verification_writer;
grant execute on function knowledge_verification.current_revocation_epoch(uuid) to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant execute on function knowledge_verification.advance_revocation_epoch(uuid, text), knowledge_verification.record_invalidation(uuid, text, text, text) to
  knowledge_verification_writer, knowledge_verification_reviewer;
grant execute on function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz),
  knowledge_verification.record_effect_receipt(uuid, text, text, jsonb, jsonb, text, text, bigint, jsonb, text, text),
  knowledge_verification.revoke_pending_dispatches(uuid, text) to knowledge_verification_writer;
grant execute on function knowledge_verification.claim_dispatches(uuid, integer, timestamptz),
  knowledge_verification.acknowledge_dispatch(uuid, text, text, timestamptz),
  knowledge_verification.fail_dispatch(uuid, text, text, interval) to knowledge_verification_outbox_worker, knowledge_verification_writer;
revoke all on function knowledge_verification.advance_revocation_epoch(uuid, text), knowledge_verification.record_invalidation(uuid, text, text, text),
  knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz),
  knowledge_verification.record_effect_receipt(uuid, text, text, jsonb, jsonb, text, text, bigint, jsonb, text, text),
  knowledge_verification.claim_dispatches(uuid, integer, timestamptz), knowledge_verification.acknowledge_dispatch(uuid, text, text, timestamptz),
  knowledge_verification.fail_dispatch(uuid, text, text, interval), knowledge_verification.revoke_pending_dispatches(uuid, text),
  knowledge_verification.current_revocation_epoch(uuid) from public;
revoke all on function knowledge_verification.reviewer_grant_only_revocable(), knowledge_verification.adjudication_requires_grant(),
  knowledge_verification.invalidation_only_closes(), knowledge_verification.use_decision_run_sealed() from public;
