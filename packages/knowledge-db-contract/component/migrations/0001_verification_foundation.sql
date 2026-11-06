-- knowledge_verification 2.0.0 / 0001_verification_foundation
-- Sprint V (SV-03, K09): the one common operational verification component installed in EACH application's
-- PostgreSQL (AI Engineer, Biotech). Owned objects: schema knowledge_verification, its NOLOGIN capability roles,
-- the tenant function, the component/installation ledger and the foundation records: origin, effect, task,
-- verification run, assertion, fragment, support set.
--
-- Rules: no domain foreign keys (AIDB/BKS own their domain schemas); tenant isolation by forced RLS on
-- `app.tenant_id`; immutable records are append-only (trigger-enforced); a sealed run has one head (CAS in 0002).
-- The installer applies every migration inside one transaction and records receipts in component_release.
-- No BEGIN/COMMIT here.

create schema if not exists knowledge_verification;
comment on schema knowledge_verification is
  'Common Knowledge Services verification/admission operational records (Sprint V K09, component 2.0.0). One owner: packages/knowledge-db-contract.';

-- ---------------------------------------------------------------------------------------------------------------
-- Capability roles (NOLOGIN). App bindings grant them to their login/bounded roles; the component never grants
-- anything to PUBLIC, anon or authenticated.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array[
    'knowledge_verification_reader',
    'knowledge_verification_writer',
    'knowledge_verification_reviewer',
    'knowledge_verification_outbox_worker'
  ] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
end $$;

revoke all on schema knowledge_verification from public;
grant usage on schema knowledge_verification to
  knowledge_verification_reader, knowledge_verification_writer,
  knowledge_verification_reviewer, knowledge_verification_outbox_worker;

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant context: the same `app.tenant_id` GUC the existing KS persistence sets per transaction. Fail closed.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function knowledge_verification.current_tenant_id() returns uuid
language plpgsql stable parallel safe set search_path = pg_catalog, pg_temp as $$
declare v text := nullif(current_setting('app.tenant_id', true), '');
begin
  if v is null then
    raise exception 'TENANT_CONTEXT_REQUIRED' using errcode = 'insufficient_privilege',
      hint = 'select set_config(''app.tenant_id'', <uuid>, true) inside the transaction';
  end if;
  if v = '00000000-0000-0000-0000-000000000000' then
    raise exception 'TENANT_CONTEXT_REQUIRED' using errcode = 'insufficient_privilege', detail = 'nil tenant';
  end if;
  return v::uuid;
end $$;
comment on function knowledge_verification.current_tenant_id() is
  'Tenant of the current transaction from app.tenant_id; raises TENANT_CONTEXT_REQUIRED when absent or nil.';

create or replace function knowledge_verification.assert_tenant(p_tenant uuid) returns void
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant is distinct from knowledge_verification.current_tenant_id() then
    raise exception 'TENANT_MISMATCH' using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function knowledge_verification.refuse_mutation() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'IMMUTABLE_RECORD' using errcode = 'integrity_constraint_violation',
    detail = format('%s.%s rows are append-only (%s)', tg_table_schema, tg_table_name, tg_op);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Component and installation ledger (written by the installer in the migration transaction).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.component_release (
  component text not null check (component = 'knowledge_verification'),
  component_version text not null check (component_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  migration_key text not null check (migration_key ~ '^[0-9]{4}_[a-z0-9_]+$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  applied_by text not null,
  primary key (component, migration_key)
);
comment on table knowledge_verification.component_release is
  'Receipt per applied migration; bytes are never edited, a changed file is refused by the installer.';

create table knowledge_verification.installation (
  singleton boolean primary key default true check (singleton),
  installation_id uuid not null,
  application_id text not null check (application_id ~ '^[a-z][a-z0-9_-]{0,59}$'),
  binding text not null check (binding ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  installed_at timestamptz not null default now()
);
comment on table knowledge_verification.installation is
  'Exactly one installation per database: which application and binding this component serves.';

create trigger installation_immutable before update or delete on knowledge_verification.installation
  for each row execute function knowledge_verification.refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Origin: the host-authenticated invocation identity (K01 origin.v2), content-addressed by its identity digest.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.origin (
  tenant_id uuid not null,
  origin_digest text not null check (origin_digest ~ '^sha256:[0-9a-f]{64}$'),
  kind text not null check (kind in ('mission_invocation', 'standalone', 'recovery', 'durable_worker')),
  installation_id text not null,
  application_id text not null,
  issuer text not null,
  subject text not null,
  mission_id text,
  mission_run_id text,
  activation_id text,
  operation_id text check (operation_id is null or operation_id not like 'manifest-template/%'),
  operation_attempt integer check (operation_attempt is null or operation_attempt >= 0),
  execution_generation integer check (execution_generation is null or execution_generation >= 0),
  lane text,
  recovery_authority_ref text,
  identity jsonb not null,
  first_seen_at timestamptz not null default now(),
  primary key (tenant_id, origin_digest),
  check ((kind = 'mission_invocation') = (mission_id is not null and mission_run_id is not null and operation_id is not null
          and operation_attempt is not null and execution_generation is not null and lane is not null)),
  check ((kind = 'recovery') = (recovery_authority_ref is not null))
);
comment on table knowledge_verification.origin is
  'Immutable origin identities (design §5). Template coordinates (manifest-template/*) are refused: a live invocation only (E01).';
create trigger origin_immutable before update or delete on knowledge_verification.origin
  for each row execute function knowledge_verification.refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Effect: one logical effect per scoped host-minted key. Same key + different bound bytes = EFFECT_CONFLICT.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.effect (
  tenant_id uuid not null,
  effect_key text not null check (effect_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  semantic_payload_digest text not null check (semantic_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  originating_origin_digest text not null,
  bound_effect_digest text not null check (bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  canonicalization text not null check (canonicalization = 'kop-canonical-json.v1'),
  lineage_effect_key text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, effect_key),
  foreign key (tenant_id, originating_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict,
  foreign key (tenant_id, lineage_effect_key) references knowledge_verification.effect (tenant_id, effect_key) on delete restrict,
  check (lineage_effect_key is null or lineage_effect_key <> effect_key)
);
comment on table knowledge_verification.effect is
  'Bound effects (design §5): effect_key, semantic payload digest, originating origin and bound_effect_digest. Edited proposals mint a new key with lineage_effect_key.';
create trigger effect_immutable before update or delete on knowledge_verification.effect
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.bind_effect(
  p_tenant uuid, p_effect_key text, p_semantic_payload_digest text, p_originating_origin_digest text,
  p_bound_effect_digest text, p_lineage_effect_key text default null
) returns knowledge_verification.effect
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare existing knowledge_verification.effect;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into existing from knowledge_verification.effect e
    where e.tenant_id = p_tenant and e.effect_key = p_effect_key for share;
  if found then
    if existing.bound_effect_digest <> p_bound_effect_digest
       or existing.semantic_payload_digest <> p_semantic_payload_digest
       or existing.originating_origin_digest <> p_originating_origin_digest then
      raise exception 'EFFECT_CONFLICT' using errcode = 'unique_violation',
        detail = 'same effect key with different bound bytes or originating origin';
    end if;
    return existing;
  end if;
  insert into knowledge_verification.effect
    (tenant_id, effect_key, semantic_payload_digest, originating_origin_digest, bound_effect_digest, canonicalization, lineage_effect_key)
  values (p_tenant, p_effect_key, p_semantic_payload_digest, p_originating_origin_digest, p_bound_effect_digest, 'kop-canonical-json.v1', p_lineage_effect_key)
  returning * into existing;
  return existing;
exception when unique_violation then
  -- Concurrent binder won the insert: re-read and compare.
  select * into existing from knowledge_verification.effect e where e.tenant_id = p_tenant and e.effect_key = p_effect_key;
  if existing.bound_effect_digest <> p_bound_effect_digest then
    raise exception 'EFFECT_CONFLICT' using errcode = 'unique_violation';
  end if;
  return existing;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Frozen task, the verification run and the core research records (K02 shapes, stored as validated JSON bodies with
-- the indexed columns the component needs; the application validates bodies against research-core schemas).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.verification_task (
  tenant_id uuid not null,
  task_id text not null,
  schema_version text not null check (schema_version = 'research-core.task.v2'),
  task_digest text not null check (task_digest ~ '^sha256:[0-9a-f]{64}$'),
  original_task_ref jsonb not null,
  use_name text not null,
  audience text not null,
  minimum_risk text not null check (minimum_risk in ('low', 'medium', 'high', 'critical')),
  rubric_ref text not null,
  policy_ref text not null,
  body jsonb not null,
  frozen_at timestamptz not null default now(),
  primary key (tenant_id, task_id),
  unique (tenant_id, task_digest)
);
comment on table knowledge_verification.verification_task is 'Frozen VerificationTaskContract: the obligation denominator never changes after freezing.';
create trigger verification_task_immutable before update or delete on knowledge_verification.verification_task
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.verification_run (
  tenant_id uuid not null,
  run_id uuid not null default gen_random_uuid(),
  task_id text not null,
  binding text not null,
  state text not null default 'preparing' check (state in ('preparing', 'observing', 'sealed', 'superseded')),
  originating_origin_digest text not null,
  mission_id text,
  mission_run_id text,
  activation_id text,
  operation_id text,
  operation_attempt integer,
  execution_generation integer,
  head_digest text check (head_digest is null or head_digest ~ '^sha256:[0-9a-f]{64}$'),
  head_sequence integer not null default 0 check (head_sequence >= 0),
  schema_versions jsonb not null default '{}'::jsonb,
  record jsonb,
  record_digest text check (record_digest is null or record_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sealed_at timestamptz,
  primary key (tenant_id, run_id),
  foreign key (tenant_id, task_id) references knowledge_verification.verification_task (tenant_id, task_id) on delete restrict,
  foreign key (tenant_id, originating_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict,
  check ((mission_id is null and mission_run_id is null and operation_id is null and operation_attempt is null and execution_generation is null)
      or (mission_id is not null and mission_run_id is not null and operation_id is not null and operation_attempt is not null and execution_generation is not null)),
  check ((state = 'sealed') = (sealed_at is not null)),
  check (state <> 'sealed' or head_digest is not null)
);
comment on table knowledge_verification.verification_run is
  'One VerificationRun (OC-D95): standalone when the mission columns are null (ADR 0007); head_digest/head_sequence are the compare-and-set seal head (design §6).';
create index verification_run_mission_idx on knowledge_verification.verification_run (tenant_id, mission_run_id, operation_id) where mission_run_id is not null;

create or replace function knowledge_verification.touch_run() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if old.state = 'sealed' and new.state <> 'superseded' then
    -- The only change a sealed run accepts is a successor manifest appended by seal_run: the head advances by one.
    if not (new.state = 'sealed' and new.head_sequence = old.head_sequence + 1 and new.head_digest is distinct from old.head_digest
            and new.binding = old.binding and new.schema_versions = old.schema_versions and new.sealed_at = old.sealed_at
            and new.mission_id is not distinct from old.mission_id and new.operation_id is not distinct from old.operation_id) then
      raise exception 'SEALED_RUN_IMMUTABLE' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  if new.tenant_id <> old.tenant_id or new.run_id <> old.run_id or new.task_id <> old.task_id
     or new.originating_origin_digest <> old.originating_origin_digest or new.created_at <> old.created_at
     or (old.record is not null and new.record is distinct from old.record) then
    raise exception 'RUN_IDENTITY_IMMUTABLE' using errcode = 'integrity_constraint_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger verification_run_touch before update on knowledge_verification.verification_run
  for each row execute function knowledge_verification.touch_run();
create trigger verification_run_no_delete before delete on knowledge_verification.verification_run
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.assertion (
  tenant_id uuid not null,
  assertion_id text not null,
  logical_id text not null,
  schema_version text not null check (schema_version = 'research-core.assertion.v2'),
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  kind text not null check (kind in ('source_report', 'world_fact', 'derivation', 'recommendation', 'forecast')),
  proposition text not null,
  profile_ref text not null,
  qualifiers jsonb not null,
  qualifiers_digest text not null check (qualifiers_digest ~ '^sha256:[0-9a-f]{64}$'),
  producer_origin_digest text not null,
  premises jsonb not null default '[]'::jsonb check (jsonb_typeof(premises) = 'array'),
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, assertion_id),
  unique (tenant_id, digest),
  foreign key (tenant_id, producer_origin_digest) references knowledge_verification.origin (tenant_id, origin_digest) on delete restrict
);
comment on table knowledge_verification.assertion is 'AssertionVersion: a qualifier change is a new version/digest, never a reused pass.';
create index assertion_logical_idx on knowledge_verification.assertion (tenant_id, logical_id);
create trigger assertion_immutable before update or delete on knowledge_verification.assertion
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.fragment (
  tenant_id uuid not null,
  fragment_id text not null,
  schema_version text not null check (schema_version = 'research-core.fragment.v2'),
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  source_ref jsonb not null,
  capture_digest text not null check (capture_digest ~ '^sha256:[0-9a-f]{64}$'),
  representation_digest text not null check (representation_digest ~ '^sha256:[0-9a-f]{64}$'),
  selector jsonb not null,
  resolver_version text not null,
  completeness text not null check (completeness in ('complete', 'partial', 'truncated', 'unknown')),
  rights_scope text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, fragment_id),
  unique (tenant_id, digest)
);
comment on table knowledge_verification.fragment is 'EvidenceFragment: raw-capture and representation digests, exact selector and resolver version, completeness and rights scope.';
create trigger fragment_immutable before update or delete on knowledge_verification.fragment
  for each row execute function knowledge_verification.refuse_mutation();

create table knowledge_verification.support_set (
  tenant_id uuid not null,
  support_set_id text not null,
  schema_version text not null check (schema_version = 'research-core.support_set.v2'),
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  assertion_id text not null,
  required jsonb not null check (jsonb_typeof(required) = 'array'),
  contrary jsonb not null default '[]'::jsonb check (jsonb_typeof(contrary) = 'array'),
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, support_set_id),
  unique (tenant_id, digest),
  foreign key (tenant_id, assertion_id) references knowledge_verification.assertion (tenant_id, assertion_id) on delete restrict
);
comment on table knowledge_verification.support_set is 'SupportSet: conjunctive across required premises; separate sets are alternatives; contrary fragments are retained.';
create trigger support_set_immutable before update or delete on knowledge_verification.support_set
  for each row execute function knowledge_verification.refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security: every record is tenant-scoped; forced so the owner is not exempt.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['origin', 'effect', 'verification_task', 'verification_run', 'assertion', 'fragment', 'support_set'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;

-- component_release and installation are not tenant-scoped: readable by every capability role, written by the installer.
grant select on knowledge_verification.component_release, knowledge_verification.installation to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;

grant select on knowledge_verification.origin, knowledge_verification.effect, knowledge_verification.verification_task,
  knowledge_verification.verification_run, knowledge_verification.assertion, knowledge_verification.fragment,
  knowledge_verification.support_set to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;

grant insert on knowledge_verification.origin, knowledge_verification.verification_task, knowledge_verification.verification_run,
  knowledge_verification.assertion, knowledge_verification.fragment, knowledge_verification.support_set to knowledge_verification_writer;
-- verification_run state moves only through component functions (seal_run in 0002) and the observing transition:
grant update (state, schema_versions, record, record_digest) on knowledge_verification.verification_run to knowledge_verification_writer;
-- effect rows are created only through bind_effect (security definer); no direct insert grant.
grant execute on function knowledge_verification.current_tenant_id(), knowledge_verification.assert_tenant(uuid) to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant execute on function knowledge_verification.bind_effect(uuid, text, text, text, text, text) to knowledge_verification_writer;
revoke all on function knowledge_verification.bind_effect(uuid, text, text, text, text, text) from public;
revoke all on function knowledge_verification.refuse_mutation() from public;
revoke all on function knowledge_verification.touch_run() from public;
