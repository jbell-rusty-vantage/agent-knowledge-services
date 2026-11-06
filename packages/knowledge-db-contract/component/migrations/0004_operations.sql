-- knowledge_verification 2.1.0 / 0004_operations
-- Sprint V SV-06 (K04/K05/K09): durable asynchronous operations (`report.assess` first) with K01 status fields,
-- monotonic revision and compare-and-set transitions; idempotent start by request id and idempotent cancellation by
-- cancel request id. Pins the exact report kind (id, semantic version, envelope schema, digest) on every report
-- revision, and adds the durable ReportAssessment record (design §3.2) that references the frozen report, its run,
-- task and kind independently of report_revision.run_id.
-- The installer wraps this file in its transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------------------------------------------
-- Operations: one row per K01 operation handle (tenant, application, binding, operation id, protocol version).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.operation (
  tenant_id uuid not null,
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  protocol_version text not null check (protocol_version = 'ks.knowledge_operation.v2'),
  application_id text not null check (application_id ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  binding text not null check (binding ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  operation_name text not null check (operation_name ~ '^[a-z][a-z0-9_.]{0,119}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  request jsonb not null,
  request_digest text not null check (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  handle_digest text not null check (handle_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text not null check (state in ('queued', 'running', 'waiting_review', 'cancelling',
                                       'succeeded', 'partial', 'held', 'rejected', 'failed', 'cancelled')),
  revision integer not null check (revision >= 1),
  originating_origin_digest text not null,
  effect_key text,
  run_id uuid,
  subject_ref jsonb,
  progress_ref jsonb,
  pending_review_ref jsonb,
  result_ref jsonb,
  error jsonb,
  unresolved_effects jsonb not null default '[]'::jsonb check (jsonb_typeof(unresolved_effects) = 'array'),
  cancel_request_id text check (cancel_request_id is null or cancel_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  retry_after_ms integer,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  terminal_at timestamptz,
  primary key (tenant_id, operation_id),
  unique (tenant_id, operation_name, request_id),
  foreign key (tenant_id, originating_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict,
  foreign key (tenant_id, effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict,
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  -- K01 OperationStatus invariants, enforced by the store as well as the protocol schema.
  check ((state in ('succeeded', 'partial', 'held', 'rejected', 'failed', 'cancelled')) = (terminal_at is not null)),
  check ((state in ('succeeded', 'partial', 'held', 'rejected', 'failed', 'cancelled')) = (retry_after_ms is null)),
  check (retry_after_ms is null or retry_after_ms between 100 and 300000),
  check (state <> 'failed' or error is not null),
  check (state <> 'waiting_review' or pending_review_ref is not null),
  check (state not in ('cancelling', 'cancelled') or cancel_request_id is not null),
  check (updated_at >= created_at)
);
comment on table knowledge_verification.operation is
  'Durable K01 operations (design §4): queued/running/waiting_review/cancelling then terminal succeeded/partial/held/rejected/failed/cancelled. Rows change only through transition_operation/cancel_operation (compare-and-set on revision).';
create index operation_run_idx on knowledge_verification.operation (tenant_id, run_id) where run_id is not null;

create or replace function knowledge_verification.operation_is_terminal(p_state text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select p_state in ('succeeded', 'partial', 'held', 'rejected', 'failed', 'cancelled')
$$;

-- The K01 transition table (packages/knowledge-operation-protocol/src/handle.ts TRANSITIONS); a binding test compares
-- every (from, to) pair with the TypeScript table so the two cannot drift silently.
create or replace function knowledge_verification.operation_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select case p_from
    when 'queued' then p_to in ('running', 'cancelling', 'cancelled', 'failed', 'rejected')
    when 'running' then p_to in ('waiting_review', 'cancelling', 'succeeded', 'partial', 'held', 'rejected', 'failed')
    when 'waiting_review' then p_to in ('running', 'cancelling', 'held', 'rejected', 'succeeded', 'partial', 'failed')
    when 'cancelling' then p_to in ('cancelled', 'succeeded', 'partial', 'held', 'rejected', 'failed')
    else false
  end
$$;

-- Defense in depth: even the definer functions cannot regress a status, skip a revision or rewrite identity.
create or replace function knowledge_verification.operation_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD' using errcode = 'integrity_constraint_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.operation_id <> old.operation_id or new.protocol_version <> old.protocol_version
     or new.application_id <> old.application_id or new.binding <> old.binding or new.operation_name <> old.operation_name
     or new.request_id <> old.request_id or new.request <> old.request or new.request_digest <> old.request_digest
     or new.handle_digest <> old.handle_digest or new.originating_origin_digest <> old.originating_origin_digest
     or new.effect_key is distinct from old.effect_key or new.run_id is distinct from old.run_id
     or new.subject_ref is distinct from old.subject_ref or new.created_at <> old.created_at
     or (old.cancel_request_id is not null and new.cancel_request_id is distinct from old.cancel_request_id) then
    raise exception 'OPERATION_IDENTITY_IMMUTABLE' using errcode = 'integrity_constraint_violation';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'REVISION_MISMATCH' using errcode = 'serialization_failure';
  end if;
  if not knowledge_verification.operation_transition_allowed(old.state, new.state) then
    raise exception 'ILLEGAL_TRANSITION' using errcode = 'integrity_constraint_violation',
      detail = format('%s -> %s', old.state, new.state);
  end if;
  return new;
end $$;
create trigger operation_guard before update or delete on knowledge_verification.operation
  for each row execute function knowledge_verification.operation_guard();

create or replace function knowledge_verification.start_operation(
  p_tenant uuid, p_operation_id text, p_application text, p_binding text, p_operation_name text, p_request_id text,
  p_request jsonb, p_request_digest text, p_handle_digest text, p_origin_digest text, p_effect_key text, p_run_id uuid,
  p_subject_ref jsonb, p_retry_after_ms integer, p_now timestamptz
) returns knowledge_verification.operation
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.operation;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  insert into knowledge_verification.operation
    (tenant_id, operation_id, protocol_version, application_id, binding, operation_name, request_id, request, request_digest,
     handle_digest, state, revision, originating_origin_digest, effect_key, run_id, subject_ref, retry_after_ms, created_at, updated_at)
  values (p_tenant, p_operation_id, 'ks.knowledge_operation.v2', p_application, p_binding, p_operation_name, p_request_id, p_request,
          p_request_digest, p_handle_digest, 'queued', 1, p_origin_digest, p_effect_key, p_run_id, p_subject_ref,
          greatest(100, least(300000, coalesce(p_retry_after_ms, 1000))), p_now, p_now)
  on conflict do nothing
  returning * into row_;
  if found then
    return row_;
  end if;
  -- Idempotent start: the same (operation, request id) returns the existing row; other input under it conflicts.
  select * into row_ from knowledge_verification.operation o
   where o.tenant_id = p_tenant and o.operation_name = p_operation_name and o.request_id = p_request_id;
  if not found or row_.request_digest <> p_request_digest or row_.operation_id <> p_operation_id then
    raise exception 'REQUEST_CONFLICT' using errcode = 'unique_violation',
      detail = 'the request id was already started with different input';
  end if;
  return row_;
end $$;

create or replace function knowledge_verification.transition_operation(
  p_tenant uuid, p_operation_id text, p_expected_revision integer, p_to_state text, p_now timestamptz,
  p_progress_ref jsonb default null, p_pending_review_ref jsonb default null, p_result_ref jsonb default null,
  p_error jsonb default null, p_unresolved_effects jsonb default null, p_retry_after_ms integer default null,
  p_cancel_request_id text default null
) returns knowledge_verification.operation
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  row_ knowledge_verification.operation;
  terminal boolean := knowledge_verification.operation_is_terminal(p_to_state);
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into row_ from knowledge_verification.operation o
   where o.tenant_id = p_tenant and o.operation_id = p_operation_id for update;
  if not found then
    raise exception 'OPERATION_NOT_FOUND' using errcode = 'no_data_found';
  end if;
  -- Idempotent cancel request: once a cancel request id is recorded (or the operation is terminal) repeats are no-ops.
  if p_cancel_request_id is not null and (row_.cancel_request_id is not null or knowledge_verification.operation_is_terminal(row_.state)) then
    return row_;
  end if;
  if row_.revision <> p_expected_revision then
    raise exception 'REVISION_MISMATCH' using errcode = 'serialization_failure',
      detail = format('expected revision %s, current %s', p_expected_revision, row_.revision);
  end if;
  if not knowledge_verification.operation_transition_allowed(row_.state, p_to_state) then
    raise exception 'ILLEGAL_TRANSITION' using errcode = 'integrity_constraint_violation',
      detail = format('%s -> %s', row_.state, p_to_state);
  end if;
  update knowledge_verification.operation set
    state = p_to_state,
    revision = row_.revision + 1,
    progress_ref = coalesce(p_progress_ref, row_.progress_ref),
    pending_review_ref = coalesce(p_pending_review_ref, row_.pending_review_ref),
    result_ref = coalesce(p_result_ref, row_.result_ref),
    error = coalesce(p_error, row_.error),
    unresolved_effects = coalesce(p_unresolved_effects, row_.unresolved_effects),
    cancel_request_id = coalesce(row_.cancel_request_id, p_cancel_request_id),
    retry_after_ms = case when terminal then null
                          else greatest(100, least(300000, coalesce(p_retry_after_ms, row_.retry_after_ms, 1000))) end,
    updated_at = greatest(p_now, row_.updated_at),
    terminal_at = case when terminal then greatest(p_now, row_.updated_at) else null end
  where tenant_id = p_tenant and operation_id = p_operation_id
  returning * into row_;
  return row_;
end $$;

-- Cancellation stops new work: queued -> cancelled at once; running/waiting_review -> cancelling (the runner settles).
create or replace function knowledge_verification.cancel_operation(
  p_tenant uuid, p_operation_id text, p_cancel_request_id text, p_now timestamptz
) returns knowledge_verification.operation
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.operation;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into row_ from knowledge_verification.operation o
   where o.tenant_id = p_tenant and o.operation_id = p_operation_id for update;
  if not found then
    raise exception 'OPERATION_NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if row_.cancel_request_id is not null or knowledge_verification.operation_is_terminal(row_.state) then
    return row_;
  end if;
  return knowledge_verification.transition_operation(
    p_tenant, p_operation_id, row_.revision, case when row_.state = 'queued' then 'cancelled' else 'cancelling' end, p_now,
    p_cancel_request_id => p_cancel_request_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Report kind pin (K08): the revision binds the exact kind document. The binding writes only the bare kind id;
-- these columns are derived from record.kind (`<kind>@<semver>`, envelope schema, digest) and must agree with it.
-- ---------------------------------------------------------------------------------------------------------------
alter table knowledge_verification.report_revision
  add column report_kind_ref_id text,
  add column report_kind_version text,
  add column report_kind_schema text,
  add column report_kind_digest text;
alter table knowledge_verification.report_revision
  add constraint report_revision_kind_pinned check (
    report_kind_ref_id is not null and report_kind_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    and report_kind_schema ~ '^[a-z][a-z0-9_.-]*\.v[0-9]+$' and report_kind_digest ~ '^sha256:[0-9a-f]{64}$'
  ) not valid;
comment on column knowledge_verification.report_revision.report_kind_digest is
  'Canonical digest of the pinned research-report-kind.v1 document (catalog/research/report-kinds). Revisions registered before 2.1.0 are not validated (NOT VALID).';

create or replace function knowledge_verification.report_revision_kind_columns() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  kind jsonb := new.record -> 'kind';
  ref_id text;
begin
  if kind is null or jsonb_typeof(kind) <> 'object' then
    raise exception 'REPORT_KIND_REQUIRED' using errcode = 'integrity_constraint_violation',
      detail = 'record.kind must be the Ref of a pinned report kind';
  end if;
  ref_id := kind ->> 'id';
  if ref_id is null or position('@' in ref_id) = 0 then
    raise exception 'REPORT_KIND_VERSION_REQUIRED' using errcode = 'integrity_constraint_violation',
      detail = 'record.kind.id is <kind>@<semver>';
  end if;
  if new.report_kind <> split_part(ref_id, '@', 1)
     or (new.report_kind_ref_id is not null and new.report_kind_ref_id <> ref_id)
     or (new.report_kind_version is not null and new.report_kind_version <> split_part(ref_id, '@', 2))
     or (new.report_kind_schema is not null and new.report_kind_schema <> kind ->> 'version')
     or (new.report_kind_digest is not null and new.report_kind_digest <> kind ->> 'digest') then
    raise exception 'REPORT_KIND_MISMATCH' using errcode = 'integrity_constraint_violation';
  end if;
  new.report_kind_ref_id := ref_id;
  new.report_kind_version := split_part(ref_id, '@', 2);
  new.report_kind_schema := kind ->> 'version';
  new.report_kind_digest := kind ->> 'digest';
  return new;
end $$;
create trigger report_revision_kind_columns before insert on knowledge_verification.report_revision
  for each row execute function knowledge_verification.report_revision_kind_columns();
create index report_revision_kind_idx on knowledge_verification.report_revision (tenant_id, report_kind, report_kind_version);

-- ---------------------------------------------------------------------------------------------------------------
-- ReportAssessment (design §3.2): one immutable assessment of one frozen report revision under one run. Its run is
-- not taken from report_revision.run_id, so a successor or replay run can assess the same frozen revision later.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.report_assessment (
  tenant_id uuid not null,
  assessment_id text not null check (assessment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  schema_version text not null check (schema_version = 'research-core.report_assessment.v1'),
  report_revision_id text not null,
  report_digest text not null check (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  run_id uuid not null,
  task_id text not null,
  report_kind_ref_id text not null,
  report_kind_digest text not null check (report_kind_digest ~ '^sha256:[0-9a-f]{64}$'),
  census_status text not null check (census_status in ('assessed', 'stale', 'not_run')),
  census_observation_id text,
  aggregate_digest text not null check (aggregate_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('succeeded', 'partial', 'held', 'rejected')),
  operation_id text,
  result_artifact_id text not null,
  record jsonb not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  assessed_at timestamptz not null,
  primary key (tenant_id, assessment_id),
  unique (tenant_id, digest),
  foreign key (tenant_id, report_revision_id) references knowledge_verification.report_revision (tenant_id, report_revision_id) on delete restrict,
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  foreign key (tenant_id, task_id) references knowledge_verification.verification_task (tenant_id, task_id) on delete restrict,
  foreign key (tenant_id, census_observation_id) references knowledge_verification.observation (tenant_id, observation_id) on delete restrict,
  foreign key (tenant_id, operation_id) references knowledge_verification.operation (tenant_id, operation_id) on delete restrict,
  foreign key (tenant_id, result_artifact_id) references knowledge_verification.artifact_custody (tenant_id, artifact_id) on delete restrict,
  check ((census_status = 'not_run') = (census_observation_id is null))
);
comment on table knowledge_verification.report_assessment is
  'ReportAssessment: references the frozen report revision, the assessing run, task and pinned kind; aggregate and outcome are content-addressed. Status views are derived joins; the revision never embeds its assessment.';
create index report_assessment_report_idx on knowledge_verification.report_assessment (tenant_id, report_revision_id);
create trigger report_assessment_immutable before update or delete on knowledge_verification.report_assessment
  for each row execute function knowledge_verification.refuse_mutation();

do $$
declare t text;
begin
  foreach t in array array['operation', 'report_assessment'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;

grant select on knowledge_verification.operation, knowledge_verification.report_assessment to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant insert on knowledge_verification.report_assessment to knowledge_verification_writer;
-- operation rows are created and moved only through the definer functions; no direct insert/update grant.
grant execute on function knowledge_verification.operation_is_terminal(text),
  knowledge_verification.operation_transition_allowed(text, text) to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant execute on function
  knowledge_verification.start_operation(uuid, text, text, text, text, text, jsonb, text, text, text, text, uuid, jsonb, integer, timestamptz),
  knowledge_verification.transition_operation(uuid, text, integer, text, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, integer, text),
  knowledge_verification.cancel_operation(uuid, text, text, timestamptz) to knowledge_verification_writer;
revoke all on function
  knowledge_verification.start_operation(uuid, text, text, text, text, text, jsonb, text, text, text, text, uuid, jsonb, integer, timestamptz),
  knowledge_verification.transition_operation(uuid, text, integer, text, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, integer, text),
  knowledge_verification.cancel_operation(uuid, text, text, timestamptz) from public;
revoke all on function knowledge_verification.operation_guard(), knowledge_verification.report_revision_kind_columns() from public;

-- ---------------------------------------------------------------------------------------------------------------
-- Occurrence identity is local to one report body (renderer/producer ids such as `occ-1`), so it is unique per report
-- revision, not per tenant: two reports of one tenant may both declare `occ-1`. Producer ledger entries only; the
-- auditor's discovered occurrences live in its custody inventory bound by the census observation.
-- ---------------------------------------------------------------------------------------------------------------
alter table knowledge_verification.occurrence drop constraint occurrence_pkey;
alter table knowledge_verification.occurrence add primary key (tenant_id, report_revision_id, occurrence_id);
