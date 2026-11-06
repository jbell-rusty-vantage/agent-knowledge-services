-- knowledge_verification 2.0.0 / 0002_observations_reports_and_custody
-- Append-only observations, immutable artifact custody references, report revisions (research-report.v2) with their
-- mandatory run association, assertion occurrences, and the sealed run manifest with its compare-and-set head.

-- ---------------------------------------------------------------------------------------------------------------
-- Artifact custody: immutable bytes live in app-scoped custody (bucket/volume/external); small bodies may be inline.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.artifact_custody (
  tenant_id uuid not null,
  artifact_id text not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  byte_length bigint not null check (byte_length >= 0),
  media_type text not null,
  custody_kind text not null check (custody_kind in ('inline', 'bucket', 'volume', 'external')),
  custody_uri text,
  inline_bytes bytea,
  created_at timestamptz not null default now(),
  primary key (tenant_id, artifact_id),
  unique (tenant_id, digest),
  check ((custody_kind = 'inline') = (inline_bytes is not null)),
  check ((custody_kind = 'inline') = (custody_uri is null)),
  check (inline_bytes is null or octet_length(inline_bytes) = byte_length),
  check (inline_bytes is null or byte_length <= 1048576)
);
comment on table knowledge_verification.artifact_custody is
  'Immutable artifact references: exact digest, size and media type; inline bytes up to 1 MiB, otherwise a custody URI. Bytes are never rewritten.';
create trigger artifact_custody_immutable before update or delete on knowledge_verification.artifact_custody
  for each row execute function knowledge_verification.refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Report revisions: research-report.v2. A revision never embeds its assessment or use decision (digest cycle).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.report_revision (
  tenant_id uuid not null,
  report_revision_id text not null,
  report_id text not null,
  revision integer not null check (revision >= 1),
  schema_version text not null check (schema_version = 'research-report.v2'),
  report_kind text not null check (report_kind ~ '^[a-z][a-z0-9_]{0,59}$'),
  task_id text not null,
  run_id uuid not null,
  structured_body_artifact_id text not null,
  body_artifact_id text not null,
  ledger_artifact_id text not null,
  body_digest text not null check (body_digest ~ '^sha256:[0-9a-f]{64}$'),
  renderer_version text not null,
  assertion_refs jsonb not null check (jsonb_typeof(assertion_refs) = 'array'),
  time_coverage jsonb not null,
  derivation_candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(derivation_candidates) = 'array'),
  supersedes_report_revision_id text,
  record jsonb not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  registered_at timestamptz not null default now(),
  primary key (tenant_id, report_revision_id),
  unique (tenant_id, report_id, revision),
  unique (tenant_id, digest),
  foreign key (tenant_id, task_id) references knowledge_verification.verification_task (tenant_id, task_id) on delete restrict,
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  foreign key (tenant_id, structured_body_artifact_id) references knowledge_verification.artifact_custody (tenant_id, artifact_id) on delete restrict,
  foreign key (tenant_id, body_artifact_id) references knowledge_verification.artifact_custody (tenant_id, artifact_id) on delete restrict,
  foreign key (tenant_id, ledger_artifact_id) references knowledge_verification.artifact_custody (tenant_id, artifact_id) on delete restrict,
  foreign key (tenant_id, supersedes_report_revision_id) references knowledge_verification.report_revision (tenant_id, report_revision_id) on delete restrict,
  check (supersedes_report_revision_id is null or supersedes_report_revision_id <> report_revision_id)
);
comment on table knowledge_verification.report_revision is
  'ReportRevision (research-report.v2): structured body, exact body bytes and ledger in custody; mandatory task and run association; a new revision supersedes, never rewrites.';
create trigger report_revision_immutable before update or delete on knowledge_verification.report_revision
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.report_body_digest_matches() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare custody_digest text;
begin
  select a.digest into custody_digest from knowledge_verification.artifact_custody a
    where a.tenant_id = new.tenant_id and a.artifact_id = new.body_artifact_id;
  if custody_digest is distinct from new.body_digest then
    raise exception 'REPORT_BODY_DIGEST_MISMATCH' using errcode = 'integrity_constraint_violation',
      detail = 'report_revision.body_digest must equal the custody digest of body_artifact_id';
  end if;
  return new;
end $$;
create trigger report_revision_body_digest before insert on knowledge_verification.report_revision
  for each row execute function knowledge_verification.report_body_digest_matches();

create table knowledge_verification.occurrence (
  tenant_id uuid not null,
  occurrence_id text not null,
  assertion_id text not null,
  report_revision_id text not null,
  span_basis text not null default 'utf16-code-units-v1' check (span_basis = 'utf16-code-units-v1'),
  span_start integer not null check (span_start >= 0),
  span_end integer not null,
  block_path text not null,
  quote_digest text not null check (quote_digest ~ '^sha256:[0-9a-f]{64}$'),
  obligations jsonb not null default '[]'::jsonb check (jsonb_typeof(obligations) = 'array'),
  primary key (tenant_id, occurrence_id),
  unique (tenant_id, report_revision_id, assertion_id, span_start, span_end),
  foreign key (tenant_id, assertion_id) references knowledge_verification.assertion (tenant_id, assertion_id) on delete restrict,
  foreign key (tenant_id, report_revision_id) references knowledge_verification.report_revision (tenant_id, report_revision_id) on delete restrict,
  check (span_end > span_start)
);
comment on table knowledge_verification.occurrence is 'AssertionOccurrence: exact UTF-16 code-unit span, block path and quote digest inside one report revision.';
create trigger occurrence_immutable before update or delete on knowledge_verification.occurrence
  for each row execute function knowledge_verification.refuse_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Observations: append-only, each attributable to an evaluator identity and a run; raw provider responses retained
-- as custody artifacts; usage/cost recorded. Never updated: a new observation supersedes by reference.
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.observation (
  tenant_id uuid not null,
  observation_id text not null,
  seq bigint generated always as identity,
  schema_version text not null check (schema_version = 'research-core.observation.v2'),
  run_id uuid not null,
  target_kind text not null check (target_kind in ('assertion', 'support_set', 'report')),
  target_id text not null,
  target_digest text not null check (target_digest ~ '^sha256:[0-9a-f]{64}$'),
  property text not null check (property in ('integrity', 'support', 'authority', 'attribution', 'census', 'challenge')),
  input_digest text not null check (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  method_ref text not null,
  evaluator jsonb not null,
  evaluator_role text not null check (evaluator_role in ('producer', 'judge', 'second_family_judge', 'auditor', 'human_reviewer')),
  outcome jsonb not null,
  rationale text not null,
  limitations jsonb not null default '[]'::jsonb check (jsonb_typeof(limitations) = 'array'),
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array'),
  raw_response_artifact_id text,
  provider_calls integer not null default 0 check (provider_calls >= 0),
  tokens bigint not null default 0 check (tokens >= 0),
  cost_usd numeric(14, 6) not null default 0 check (cost_usd >= 0),
  record jsonb not null,
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, observation_id),
  unique (tenant_id, digest),
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  foreign key (tenant_id, raw_response_artifact_id) references knowledge_verification.artifact_custody (tenant_id, artifact_id) on delete restrict
);
comment on table knowledge_verification.observation is
  'VerificationObservation: append-only per (target, property, input digest, method, evaluator). Producer observations never count as the final census (E03/E04).';
create index observation_target_idx on knowledge_verification.observation (tenant_id, target_kind, target_id, property);
create index observation_run_idx on knowledge_verification.observation (tenant_id, run_id);
create trigger observation_immutable before update or delete on knowledge_verification.observation
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.observation_run_open() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare run_state text;
begin
  select r.state into run_state from knowledge_verification.verification_run r
    where r.tenant_id = new.tenant_id and r.run_id = new.run_id for share;
  if run_state is null then
    raise exception 'RUN_NOT_FOUND' using errcode = 'foreign_key_violation';
  end if;
  if run_state in ('sealed', 'superseded') then
    raise exception 'RUN_SEALED' using errcode = 'integrity_constraint_violation',
      detail = 'observations are appended to an open run; a sealed run gets a successor run';
  end if;
  return new;
end $$;
create trigger observation_run_open before insert on knowledge_verification.observation
  for each row execute function knowledge_verification.observation_run_open();

-- ---------------------------------------------------------------------------------------------------------------
-- Run manifests and the seal: canonical unsigned manifest bytes -> digest; detached seal covers that digest.
-- The manifest never contains its own digest (checked), never re-signs family bytes, and the run head moves by
-- compare-and-set so exactly one committed head succeeds (design §6).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.run_manifest (
  tenant_id uuid not null,
  run_id uuid not null,
  sequence integer not null check (sequence >= 1),
  manifest_kind text not null check (manifest_kind in ('verification_snapshot', 'decision_snapshot', 'admission_snapshot')),
  schema_version text not null check (schema_version = 'research-core.run_manifest.v2'),
  predecessor_digest text check (predecessor_digest is null or predecessor_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb not null,
  manifest_digest text not null check (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  family_refs jsonb not null check (jsonb_typeof(family_refs) = 'object'),
  signer text not null,
  signature_ref text not null,
  sealed_at timestamptz not null default now(),
  primary key (tenant_id, run_id, sequence),
  unique (tenant_id, manifest_digest),
  foreign key (tenant_id, run_id) references knowledge_verification.verification_run (tenant_id, run_id) on delete restrict,
  check ((sequence = 1) = (predecessor_digest is null))
);
comment on table knowledge_verification.run_manifest is
  'Sealed manifests of one run lineage: verification_snapshot first, then decision/admission snapshots that reference prior digests; append-only.';
create trigger run_manifest_immutable before update or delete on knowledge_verification.run_manifest
  for each row execute function knowledge_verification.refuse_mutation();

create or replace function knowledge_verification.seal_run(
  p_tenant uuid, p_run_id uuid, p_expected_head text, p_manifest_kind text, p_manifest jsonb, p_manifest_digest text,
  p_family_refs jsonb, p_signer text, p_signature_ref text
) returns knowledge_verification.run_manifest
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  run knowledge_verification.verification_run;
  sealed knowledge_verification.run_manifest;
  next_sequence integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  select * into run from knowledge_verification.verification_run r
    where r.tenant_id = p_tenant and r.run_id = p_run_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'foreign_key_violation';
  end if;
  if run.head_digest is distinct from p_expected_head then
    raise exception 'HEAD_MISMATCH' using errcode = 'serialization_failure',
      detail = format('expected head %s, committed head %s', coalesce(p_expected_head, '<none>'), coalesce(run.head_digest, '<none>'));
  end if;
  if run.state = 'superseded' then
    raise exception 'RUN_SUPERSEDED' using errcode = 'integrity_constraint_violation';
  end if;
  if position(p_manifest_digest in p_manifest::text) > 0 then
    raise exception 'MANIFEST_SELF_REFERENCE' using errcode = 'integrity_constraint_violation',
      detail = 'a manifest never contains its own digest or signature';
  end if;
  if p_manifest_kind = 'verification_snapshot' then
    if run.head_digest is not null then
      raise exception 'VERIFICATION_SNAPSHOT_EXISTS' using errcode = 'integrity_constraint_violation';
    end if;
    if not (p_family_refs ? 'claims' and p_family_refs ? 'report' and p_family_refs ? 'capture') then
      raise exception 'FAMILY_REFS_INCOMPLETE' using errcode = 'integrity_constraint_violation',
        detail = 'a verification snapshot references capture, claims and report family seals';
    end if;
    if not exists (select 1 from knowledge_verification.report_revision rr where rr.tenant_id = p_tenant and rr.run_id = p_run_id) then
      raise exception 'REPORT_RUN_LINK_REQUIRED' using errcode = 'integrity_constraint_violation';
    end if;
  elsif run.head_digest is null then
    raise exception 'VERIFICATION_SNAPSHOT_REQUIRED' using errcode = 'integrity_constraint_violation',
      detail = 'decision and admission snapshots follow the verification snapshot';
  end if;
  next_sequence := run.head_sequence + 1;
  insert into knowledge_verification.run_manifest
    (tenant_id, run_id, sequence, manifest_kind, schema_version, predecessor_digest, manifest, manifest_digest, family_refs, signer, signature_ref)
  values (p_tenant, p_run_id, next_sequence, p_manifest_kind, 'research-core.run_manifest.v2', run.head_digest, p_manifest, p_manifest_digest, p_family_refs, p_signer, p_signature_ref)
  returning * into sealed;
  update knowledge_verification.verification_run
     set head_digest = p_manifest_digest, head_sequence = next_sequence, state = 'sealed', sealed_at = coalesce(sealed_at, now())
   where tenant_id = p_tenant and run_id = p_run_id;
  return sealed;
end $$;
comment on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text) is
  'Compare-and-set seal: refuses HEAD_MISMATCH, self-referencing manifests, incomplete family refs and a verification snapshot without a report/run link.';

-- The sealed-run guard in 0001 (touch_run) refuses state changes after sealing; seal_run is the only path that sets
-- head_digest because the writer role has no UPDATE grant on those columns.

do $$
declare t text;
begin
  foreach t in array array['artifact_custody', 'report_revision', 'occurrence', 'observation', 'run_manifest'] loop
    execute format('alter table knowledge_verification.%I enable row level security', t);
    execute format('alter table knowledge_verification.%I force row level security', t);
    execute format('create policy tenant_isolation on knowledge_verification.%I using (tenant_id = knowledge_verification.current_tenant_id()) with check (tenant_id = knowledge_verification.current_tenant_id())', t);
  end loop;
end $$;

grant select on knowledge_verification.artifact_custody, knowledge_verification.report_revision, knowledge_verification.occurrence,
  knowledge_verification.observation, knowledge_verification.run_manifest to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant insert on knowledge_verification.artifact_custody, knowledge_verification.report_revision, knowledge_verification.occurrence,
  knowledge_verification.observation to knowledge_verification_writer;
grant execute on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text) to knowledge_verification_writer;
revoke all on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text) from public;
revoke all on function knowledge_verification.report_body_digest_matches() from public;
revoke all on function knowledge_verification.observation_run_open() from public;
