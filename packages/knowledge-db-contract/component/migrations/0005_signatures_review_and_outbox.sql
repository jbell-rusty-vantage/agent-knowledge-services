-- knowledge_verification 2.2.0 / 0005_signatures_review_and_outbox
-- Sprint V SV-07/SV-08 (K07, K09, design §6, §7, §9; Checkpoint A schema rows):
--   1. Detached Ed25519 seal signatures on run_manifest, an installation-level pinned signing-key registry, seal_run
--      requiring the families of each snapshot kind (observations mandatory for verification snapshots), the manifest's
--      own run/snapshot/predecessor bindings, and a new `correction_snapshot` successor kind.
--   2. Exact-use decisions bind normalized values (+ digest) and a nullable qualifiers digest (report subjects bind
--      none); admit_exact_use compares p_normalized_values_digest and requires an approving, exactly bound, in-scope,
--      still-live reviewer adjudication when the decision is conditioned on `review_required`.
--   3. Reviewer grants are scoped (uses / audiences / report kinds); an adjudication binds the decision it reviews, its
--      subject, effect and qualifiers digests; the decision guard checks all of them.
--   4. Outbox fields BKS needs (bound effect digest, decision, revocation epoch, expected marker digest/scheme),
--      enqueue only through enqueue_dispatch (an admitted, unsuperseded decision for the same bound digest), verified
--      acknowledgment only from `dispatched`, and invalidation closure revoking pending dispatches of affected decisions.
-- Rows written before 2.2.0 are not revalidated (checks are NOT VALID). The installer wraps this file in its
-- transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Seal signatures and the pinned signing-key registry (K07).
-- ---------------------------------------------------------------------------------------------------------------
create table knowledge_verification.seal_signing_key (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  algorithm text not null check (algorithm = 'Ed25519'),
  public_key bytea not null check (octet_length(public_key) = 32),
  status text not null default 'active' check (status in ('active', 'retiring', 'revoked')),
  issuer text not null check (issuer ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  registered_at timestamptz not null default now(),
  status_changed_at timestamptz
);
comment on table knowledge_verification.seal_signing_key is
  'Installation-level pinned seal keys (K07): active keys sign new seals, retiring keys still verify old ones, revoked keys verify nothing. Written only by the database owner (operator key ceremony), never by capability roles.';

create or replace function knowledge_verification.seal_signing_key_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD' using errcode = 'integrity_constraint_violation';
  end if;
  if new.key_id <> old.key_id or new.algorithm <> old.algorithm or new.public_key <> old.public_key
     or new.issuer <> old.issuer or new.registered_at <> old.registered_at
     or (old.status = 'revoked' and new.status <> 'revoked')
     or (old.status = 'retiring' and new.status = 'active') then
    raise exception 'SIGNING_KEY_ONLY_RETIRES' using errcode = 'integrity_constraint_violation';
  end if;
  new.status_changed_at := now();
  return new;
end $$;
create trigger seal_signing_key_guard before update or delete on knowledge_verification.seal_signing_key
  for each row execute function knowledge_verification.seal_signing_key_guard();

alter table knowledge_verification.run_manifest
  add column signature_alg text,
  add column signing_key_id text,
  add column signature bytea,
  add column signer_context jsonb;
alter table knowledge_verification.run_manifest alter column signature_ref drop not null;
alter table knowledge_verification.run_manifest
  add constraint run_manifest_signed check (
    signature_alg = 'Ed25519' and signing_key_id is not null and octet_length(signature) = 64
    and jsonb_typeof(signer_context) = 'object'
  ) not valid,
  add constraint run_manifest_signing_key_fk foreign key (signing_key_id)
    references knowledge_verification.seal_signing_key (key_id) on delete restrict;
alter table knowledge_verification.run_manifest drop constraint run_manifest_manifest_kind_check;
alter table knowledge_verification.run_manifest add constraint run_manifest_manifest_kind_check
  check (manifest_kind in ('verification_snapshot', 'decision_snapshot', 'admission_snapshot', 'correction_snapshot'));
comment on column knowledge_verification.run_manifest.signature is
  'Detached Ed25519 signature (64 bytes) over the canonical bytes of {manifestDigest, signer, signedAt, keyId} (research-core sealSigningBytes); verified by the binding against the pinned key before the CAS and on every load.';

drop function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text);
create or replace function knowledge_verification.seal_run(
  p_tenant uuid, p_run_id uuid, p_expected_head text, p_manifest_kind text, p_manifest jsonb, p_manifest_digest text,
  p_family_refs jsonb, p_signer text, p_signature_alg text, p_signing_key_id text, p_signature bytea, p_signer_context jsonb
) returns knowledge_verification.run_manifest
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  run knowledge_verification.verification_run;
  sealed knowledge_verification.run_manifest;
  signing_key knowledge_verification.seal_signing_key;
  next_sequence integer;
  required_families text[];
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
  -- The manifest names exactly this run, kind and predecessor: a sealed manifest replayed into another run, or an
  -- importer re-sealing old bytes over a newer head, refuses.
  if p_manifest ->> 'snapshot' is distinct from p_manifest_kind then
    raise exception 'MANIFEST_KIND_MISMATCH' using errcode = 'integrity_constraint_violation';
  end if;
  if p_manifest -> 'run' ->> 'id' is distinct from p_run_id::text then
    raise exception 'RUN_LINK_MISMATCH' using errcode = 'integrity_constraint_violation',
      detail = 'the manifest names a different verification run';
  end if;
  if p_manifest -> 'predecessor' ->> 'digest' is distinct from run.head_digest then
    raise exception 'LINEAGE_MISMATCH' using errcode = 'integrity_constraint_violation',
      detail = 'a successor manifest names the committed head as its predecessor';
  end if;
  -- Signature: a pinned, active key of the one accepted algorithm; the context names the same signer and key.
  select * into signing_key from knowledge_verification.seal_signing_key k where k.key_id = p_signing_key_id;
  if not found then
    raise exception 'SEAL_INVALID' using errcode = 'integrity_constraint_violation', detail = 'unknown signing key';
  end if;
  if signing_key.status <> 'active' then
    raise exception 'SEAL_INVALID' using errcode = 'integrity_constraint_violation', detail = 'signing key is not active';
  end if;
  if p_signature_alg is distinct from 'Ed25519' or signing_key.algorithm <> p_signature_alg
     or p_signature is null or octet_length(p_signature) <> 64 then
    raise exception 'SEAL_INVALID' using errcode = 'integrity_constraint_violation', detail = 'algorithm or signature length';
  end if;
  if p_signer_context ->> 'keyId' is distinct from p_signing_key_id or p_signer_context ->> 'signer' is distinct from p_signer
     or p_signer_context ->> 'manifestDigest' is distinct from p_manifest_digest then
    raise exception 'SEAL_INVALID' using errcode = 'integrity_constraint_violation', detail = 'signer context mismatch';
  end if;
  required_families := case p_manifest_kind
    when 'verification_snapshot' then array['capture', 'claims', 'report', 'observations']
    when 'decision_snapshot' then array['report', 'decisions']
    when 'admission_snapshot' then array['report', 'decisions']
    when 'correction_snapshot' then array['report', 'observations']
  end;
  if required_families is null then
    raise exception 'MANIFEST_KIND_UNSUPPORTED' using errcode = 'invalid_parameter_value';
  end if;
  if not (p_family_refs ?& required_families) then
    raise exception 'FAMILY_REFS_INCOMPLETE' using errcode = 'integrity_constraint_violation',
      detail = format('%s references %s', p_manifest_kind, array_to_string(required_families, ', '));
  end if;
  if p_manifest_kind = 'verification_snapshot' then
    if run.head_digest is not null then
      raise exception 'VERIFICATION_SNAPSHOT_EXISTS' using errcode = 'integrity_constraint_violation';
    end if;
    if not exists (select 1 from knowledge_verification.report_revision rr where rr.tenant_id = p_tenant and rr.run_id = p_run_id) then
      raise exception 'REPORT_RUN_LINK_REQUIRED' using errcode = 'integrity_constraint_violation';
    end if;
  elsif run.head_digest is null then
    raise exception 'VERIFICATION_SNAPSHOT_REQUIRED' using errcode = 'integrity_constraint_violation',
      detail = 'decision, admission and correction snapshots follow the verification snapshot';
  end if;
  next_sequence := run.head_sequence + 1;
  insert into knowledge_verification.run_manifest
    (tenant_id, run_id, sequence, manifest_kind, schema_version, predecessor_digest, manifest, manifest_digest, family_refs, signer,
     signature_ref, signature_alg, signing_key_id, signature, signer_context)
  values (p_tenant, p_run_id, next_sequence, p_manifest_kind, 'research-core.run_manifest.v2', run.head_digest, p_manifest, p_manifest_digest,
          p_family_refs, p_signer, null, p_signature_alg, p_signing_key_id, p_signature, p_signer_context)
  returning * into sealed;
  update knowledge_verification.verification_run
     set head_digest = p_manifest_digest, head_sequence = next_sequence, state = 'sealed', sealed_at = coalesce(sealed_at, now())
   where tenant_id = p_tenant and run_id = p_run_id;
  return sealed;
end $$;
comment on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text, text, bytea, jsonb) is
  'Compare-and-set seal (2.2.0): refuses HEAD_MISMATCH, self-reference, a manifest naming another run/kind/predecessor, an unknown/inactive key or malformed signature (SEAL_INVALID), missing families per snapshot kind and a verification snapshot without a report/run link. Ed25519 verification itself is performed by the binding before this call and on every load.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Exact-use decisions: nullable qualifiers digest (report subjects), normalized values + digest.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function knowledge_verification.normalized_values_valid(p_values jsonb) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  -- OQ2: a flat object of string | safe integer | boolean | null; no nested values, no floats or exponents.
  select jsonb_typeof(p_values) = 'object'
     and not exists (
       select 1 from jsonb_each(p_values) e
        where jsonb_typeof(e.value) in ('object', 'array')
           or (jsonb_typeof(e.value) = 'number' and (e.value::text ~ '[.eE]' or abs(e.value::text::numeric) > 9007199254740991))
           or e.key !~ '^[a-z][a-z0-9_.-]{0,119}$')
$$;

alter table knowledge_verification.use_decision alter column qualifiers_digest drop not null;
alter table knowledge_verification.use_decision
  add column normalized_values jsonb,
  add column normalized_values_digest text check (normalized_values_digest is null or normalized_values_digest ~ '^sha256:[0-9a-f]{64}$');
alter table knowledge_verification.use_decision
  add constraint use_decision_qualifiers_subject check ((subject_kind = 'assertion') = (qualifiers_digest is not null)) not valid,
  add constraint use_decision_normalized_values check (
    normalized_values is not null and normalized_values_digest is not null
    and knowledge_verification.normalized_values_valid(normalized_values)
  ) not valid;
comment on column knowledge_verification.use_decision.normalized_values_digest is
  'K01 canonical digest of normalized_values (computed by the binding from the validated record); admit_exact_use compares it with the values the native transaction is about to write.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Scoped reviewer grants and exactly bound adjudications.
-- ---------------------------------------------------------------------------------------------------------------
alter table knowledge_verification.reviewer_grant
  add constraint reviewer_grant_scope_shape check (
    jsonb_typeof(scope) = 'object'
    and jsonb_typeof(scope -> 'uses') = 'array' and jsonb_typeof(scope -> 'audiences') = 'array'
    and jsonb_typeof(scope -> 'reportKinds') = 'array'
  ) not valid;
comment on column knowledge_verification.reviewer_grant.scope is
  'Since 2.2.0: {"uses": [...], "audiences": [...], "reportKinds": [...]}; "*" is an explicit wildcard. A grant without a listed value qualifies for nothing.';

create or replace function knowledge_verification.grant_covers(p_scope jsonb, p_use text, p_audience text, p_report_kind text)
returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_scope -> 'uses', '[]'::jsonb) ?| array['*', coalesce(p_use, '*')]
     and coalesce(p_scope -> 'audiences', '[]'::jsonb) ?| array['*', coalesce(p_audience, '*')]
     and coalesce(p_scope -> 'reportKinds', '[]'::jsonb) ?| array['*', coalesce(p_report_kind, '*')]
     and (p_use is not null or p_scope -> 'uses' ? '*')
     and (p_audience is not null or p_scope -> 'audiences' ? '*')
     and (p_report_kind is not null or p_scope -> 'reportKinds' ? '*')
$$;

alter table knowledge_verification.adjudication
  add column use_decision_id text,
  add column qualifiers_digest text check (qualifiers_digest is null or qualifiers_digest ~ '^sha256:[0-9a-f]{64}$'),
  add column grant_id uuid,
  add column record jsonb;
alter table knowledge_verification.adjudication
  add constraint adjudication_use_decision_fk foreign key (tenant_id, use_decision_id)
    references knowledge_verification.use_decision (tenant_id, use_decision_id) on delete restrict,
  add constraint adjudication_grant_fk foreign key (tenant_id, grant_id)
    references knowledge_verification.reviewer_grant (tenant_id, grant_id) on delete restrict;

-- The use/audience/report kind a decision is about (the kind of the report revision its record names).
create or replace function knowledge_verification.decision_scope(p_tenant uuid, p_use_decision_id text,
  out use_name text, out audience text, out report_kind text, out subject_kind text, out subject_id text,
  out subject_digest text, out bound_effect_digest text, out qualifiers_digest text)
language sql stable set search_path = pg_catalog, pg_temp as $$
  select u.use_name, u.audience, rr.report_kind, u.subject_kind, u.subject_id, u.subject_digest, u.bound_effect_digest,
         u.qualifiers_digest
    from knowledge_verification.use_decision u
    left join knowledge_verification.report_revision rr
      on rr.tenant_id = u.tenant_id and rr.report_revision_id = (u.record -> 'report' ->> 'id')
   where u.tenant_id = p_tenant and u.use_decision_id = p_use_decision_id
$$;

-- An adjudication needs a live grant whose scope covers the reviewed decision's use, audience and report kind, and
-- binds that decision's exact subject, effect digest and qualifiers digest. Without a decision, only a full wildcard
-- grant qualifies.
create or replace function knowledge_verification.adjudication_requires_grant() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare s record; g knowledge_verification.reviewer_grant; v_use text; v_audience text; v_kind text;
begin
  if new.use_decision_id is not null then
    select * into s from knowledge_verification.decision_scope(new.tenant_id, new.use_decision_id);
    v_use := s.use_name;
    v_audience := s.audience;
    v_kind := s.report_kind;
    if v_use is null then
      raise exception 'DECISION_NOT_FOUND' using errcode = 'foreign_key_violation';
    end if;
    if new.subject_kind is distinct from s.subject_kind or new.subject_id is distinct from s.subject_id
       or new.subject_digest is distinct from s.subject_digest then
      raise exception 'ADJUDICATION_SUBJECT_MISMATCH' using errcode = 'integrity_constraint_violation',
        detail = 'an adjudication of a use decision names that decision''s exact subject';
    end if;
    if new.bound_effect_digest is distinct from s.bound_effect_digest or new.qualifiers_digest is distinct from s.qualifiers_digest then
      raise exception 'REVIEW_BINDING_MISMATCH' using errcode = 'integrity_constraint_violation',
        detail = 'the reviewer signs the decision''s exact effect and qualifiers digests';
    end if;
  end if;
  select * into g from knowledge_verification.reviewer_grant gr
   where gr.tenant_id = new.tenant_id and gr.reviewer_id = new.reviewer_id
     and gr.granted_at <= new.decided_at and (gr.revoked_at is null or gr.revoked_at > new.decided_at)
     and knowledge_verification.grant_covers(gr.scope, v_use, v_audience, v_kind)
     and (new.grant_id is null or gr.grant_id = new.grant_id)
   order by gr.granted_at desc limit 1;
  if not found then
    raise exception 'REVIEWER_NOT_QUALIFIED' using errcode = 'insufficient_privilege',
      detail = format('reviewer %s holds no live grant covering %s/%s/%s at %s', new.reviewer_id,
                      coalesce(v_use, '*'), coalesce(v_audience, '*'), coalesce(v_kind, '*'), new.decided_at);
  end if;
  new.grant_id := g.grant_id;
  return new;
end $$;

-- Decision guard (replaces 0003): sealed run; normalized values equal the record; a named adjudication binds this
-- decision's subject, effect and qualifiers digests (and reviewed the decision this one supersedes); an admitted
-- decision needs an approval; a successor keeps the superseded decision's subject, use and audience.
create or replace function knowledge_verification.use_decision_run_sealed() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare run_state text; adj knowledge_verification.adjudication; prior knowledge_verification.use_decision;
begin
  select r.state into run_state from knowledge_verification.verification_run r
    where r.tenant_id = new.tenant_id and r.run_id = new.run_id;
  if run_state is distinct from 'sealed' then
    raise exception 'RUN_NOT_SEALED' using errcode = 'integrity_constraint_violation',
      detail = 'a use decision references a sealed verification snapshot';
  end if;
  if new.normalized_values is not null and new.record ? 'normalizedValues'
     and new.normalized_values is distinct from new.record -> 'normalizedValues' then
    raise exception 'NORMALIZED_VALUES_MISMATCH' using errcode = 'integrity_constraint_violation',
      detail = 'normalized_values must equal record.normalizedValues';
  end if;
  if new.supersedes_use_decision_id is not null then
    select * into prior from knowledge_verification.use_decision p
     where p.tenant_id = new.tenant_id and p.use_decision_id = new.supersedes_use_decision_id;
    if prior.subject_kind is distinct from new.subject_kind or prior.subject_id is distinct from new.subject_id
       or prior.subject_digest is distinct from new.subject_digest or prior.use_name is distinct from new.use_name
       or prior.audience is distinct from new.audience then
      raise exception 'SUCCESSOR_SUBJECT_MISMATCH' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  if new.reviewer_adjudication_id is not null then
    select * into adj from knowledge_verification.adjudication a
      where a.tenant_id = new.tenant_id and a.adjudication_id = new.reviewer_adjudication_id;
    if adj.bound_effect_digest is distinct from new.bound_effect_digest then
      raise exception 'REVIEW_BINDING_MISMATCH' using errcode = 'integrity_constraint_violation',
        detail = 'the reviewer signed a different effect digest than this decision admits';
    end if;
    if adj.use_decision_id is not null and (
         adj.subject_kind is distinct from new.subject_kind or adj.subject_id is distinct from new.subject_id
         or adj.subject_digest is distinct from new.subject_digest
         or adj.qualifiers_digest is distinct from new.qualifiers_digest
         or adj.use_decision_id is distinct from new.supersedes_use_decision_id) then
      raise exception 'ADJUDICATION_SUBJECT_MISMATCH' using errcode = 'integrity_constraint_violation',
        detail = 'the adjudication reviewed another subject, qualifiers or decision';
    end if;
    if new.disposition = 'admitted' and adj.decision <> 'approve' then
      raise exception 'REVIEW_NOT_APPROVED' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  return new;
end $$;

-- The ONE exact-use rule (2.2.0), shared by admit_exact_use (the native-transaction admission, under the epoch lock)
-- and check_use_eligibility (side-effect-free official reads). Stable codes; AIDB research.require_admitted_use maps
-- them to KSA01..KSA04.
create or replace function knowledge_verification.exact_use_rule(
  p_tenant uuid, p_use_decision_id text, p_bound_effect_digest text, p_processed_epoch bigint, p_now timestamptz,
  p_normalized_values_digest text, p_authoritative_epoch bigint
) returns table (outcome text, reason text, authoritative_epoch bigint, decision_epoch bigint)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d knowledge_verification.use_decision; auth bigint := p_authoritative_epoch; adj knowledge_verification.adjudication; s record;
begin
  select * into d from knowledge_verification.use_decision u where u.tenant_id = p_tenant and u.use_decision_id = p_use_decision_id;
  if not found then
    return query select 'rejected', 'DECISION_NOT_FOUND', auth, null::bigint; return;
  end if;
  if exists (select 1 from knowledge_verification.use_decision sx where sx.tenant_id = p_tenant and sx.supersedes_use_decision_id = d.use_decision_id) then
    return query select 'held', 'STALE_DECISION', auth, d.revocation_epoch; return;
  end if;
  if d.disposition <> 'admitted' then
    return query select d.disposition, 'DECISION_' || upper(d.disposition), auth, d.revocation_epoch; return;
  end if;
  if d.bound_effect_digest <> p_bound_effect_digest then
    return query select 'rejected', 'EFFECT_DIGEST_MISMATCH', auth, d.revocation_epoch; return;
  end if;
  -- A caller that writes normalized values presents their digest; it must equal the decision's exactly. (A null
  -- argument is the 2.1.0 call shape and the read path; callers that write domain values must pass it.)
  if p_normalized_values_digest is not null and d.normalized_values_digest is distinct from p_normalized_values_digest then
    return query select 'rejected', 'NORMALIZED_VALUES_MISMATCH', auth, d.revocation_epoch; return;
  end if;
  if d.expires_at is not null and d.expires_at <= p_now then
    return query select 'held', 'DECISION_EXPIRED', auth, d.revocation_epoch; return;
  end if;
  if p_processed_epoch is null or p_processed_epoch < auth then
    return query select 'held', 'REVOCATION_EPOCH_STALE', auth, d.revocation_epoch; return;
  end if;
  if exists (
    select 1 from knowledge_verification.invalidation i
     where i.tenant_id = p_tenant and i.epoch > d.revocation_epoch and i.closure_processed_at is null
  ) then
    return query select 'held', 'INVALIDATION_CLOSURE_INCOMPLETE', auth, d.revocation_epoch; return;
  end if;
  if exists (
    select 1 from knowledge_verification.invalidation_affected a
     where a.tenant_id = p_tenant and a.affected_kind = 'use_decision' and a.affected_id = d.use_decision_id
  ) then
    return query select 'rejected', 'DECISION_INVALIDATED', auth, d.revocation_epoch; return;
  end if;
  -- Review: an approving adjudication that binds exactly this decision's subject, effect and qualifiers digests,
  -- made under a grant that still covers the decision's scope now (a revoked grant withdraws the authority).
  if d.conditions ? 'review_required' then
    if d.reviewer_adjudication_id is null then
      return query select 'held', 'REVIEW_REQUIRED', auth, d.revocation_epoch; return;
    end if;
    select * into adj from knowledge_verification.adjudication a
     where a.tenant_id = p_tenant and a.adjudication_id = d.reviewer_adjudication_id;
    select * into s from knowledge_verification.decision_scope(p_tenant, d.use_decision_id);
    if adj.decision is distinct from 'approve' or adj.bound_effect_digest is distinct from d.bound_effect_digest
       or adj.qualifiers_digest is distinct from d.qualifiers_digest or adj.subject_kind is distinct from d.subject_kind
       or adj.subject_id is distinct from d.subject_id or adj.subject_digest is distinct from d.subject_digest
       or not exists (
         select 1 from knowledge_verification.reviewer_grant g
          where g.tenant_id = p_tenant and g.grant_id = adj.grant_id
            and (g.revoked_at is null or g.revoked_at > p_now)
            and knowledge_verification.grant_covers(g.scope, s.use_name, s.audience, s.report_kind)) then
      return query select 'held', 'REVIEW_REQUIRED', auth, d.revocation_epoch; return;
    end if;
  end if;
  return query select 'admitted', 'OK', auth, d.revocation_epoch;
end $$;

drop function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz);
create or replace function knowledge_verification.admit_exact_use(
  p_tenant uuid, p_use_decision_id text, p_bound_effect_digest text, p_processed_epoch bigint,
  p_now timestamptz default now(), p_normalized_values_digest text default null
) returns table (outcome text, reason text, authoritative_epoch bigint)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare auth bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  -- Lock the epoch row so a concurrent advance serializes against this admission (held until the caller commits).
  insert into knowledge_verification.revocation_epoch (tenant_id, epoch, reason) values (p_tenant, 0, 'initial') on conflict do nothing;
  select e.epoch into auth from knowledge_verification.revocation_epoch e where e.tenant_id = p_tenant for share;
  return query select r.outcome, r.reason, r.authoritative_epoch
    from knowledge_verification.exact_use_rule(p_tenant, p_use_decision_id, p_bound_effect_digest, p_processed_epoch, p_now,
                                               p_normalized_values_digest, auth) r;
end $$;
comment on function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz, text) is
  'Exact-use admission under the epoch lock (2.2.0): exact effect digest, normalized values digest when presented, unexpired, not superseded/invalidated, processed_epoch >= authoritative, closure complete, and a live in-scope approving adjudication for review-conditioned decisions (exact_use_rule). Call it on the native transaction''s own connection.';

-- Side-effect-free eligibility for official reads (BKS, reader/outbox roles): the same rule, nothing recorded or
-- locked; the reader is checked against the CURRENT authoritative epoch.
create or replace function knowledge_verification.check_use_eligibility(
  p_tenant uuid, p_use_decision_id text, p_bound_effect_digest text, p_now timestamptz default now()
) returns table (state text, reason text, authoritative_epoch bigint, decision_epoch bigint)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare auth bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  auth := coalesce((select e.epoch from knowledge_verification.revocation_epoch e where e.tenant_id = p_tenant), 0);
  return query select r.outcome, r.reason, r.authoritative_epoch, r.decision_epoch
    from knowledge_verification.exact_use_rule(p_tenant, p_use_decision_id, p_bound_effect_digest, auth, p_now, null, auth) r;
end $$;
comment on function knowledge_verification.check_use_eligibility(uuid, text, text, timestamptz) is
  'Read-only exact-use eligibility (2.2.0) for official reads: the admit_exact_use rule at the current authoritative epoch, recording and locking nothing. Authority unavailable (no answer) must hold.';

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Dispatch outbox: binding fields, enqueue through a guarded function, verified acknowledgment with a stored
--    acknowledgment record, terminal settlement, per-target claims and revocation by invalidation closure.
-- ---------------------------------------------------------------------------------------------------------------
alter table knowledge_verification.dispatch_outbox drop constraint dispatch_outbox_state_check;
alter table knowledge_verification.dispatch_outbox add constraint dispatch_outbox_state_check
  check (state in ('pending', 'dispatched', 'acknowledged', 'failed', 'revoked', 'refused'));
alter table knowledge_verification.dispatch_outbox
  add column bound_effect_digest text check (bound_effect_digest is null or bound_effect_digest ~ '^sha256:[0-9a-f]{64}$'),
  add column use_decision_id text,
  add column revocation_epoch bigint check (revocation_epoch is null or revocation_epoch >= 0),
  add column marker_scheme text check (marker_scheme is null or marker_scheme in ('ks-intent-marker.v1', 'bks-intent-marker-digest.v1')),
  add column expected_marker_digest text check (expected_marker_digest is null or expected_marker_digest ~ '^sha256:[0-9a-f]{64}$'),
  add column ack_outcome text check (ack_outcome is null or ack_outcome in ('applied', 'noop')),
  add column ack_record jsonb check (ack_record is null or jsonb_typeof(ack_record) = 'object'),
  add column graph_tx_ref text,
  add column settled_at timestamptz,
  add column settle_detail jsonb check (settle_detail is null or jsonb_typeof(settle_detail) = 'object');
alter table knowledge_verification.dispatch_outbox
  add constraint dispatch_outbox_bound check (
    bound_effect_digest is not null and use_decision_id is not null and revocation_epoch is not null and marker_scheme is not null
    and (marker_scheme <> 'ks-intent-marker.v1' or expected_marker_digest is not null)
  ) not valid,
  add constraint dispatch_outbox_acknowledged_record check (state <> 'acknowledged' or ack_outcome is not null) not valid,
  add constraint dispatch_outbox_settled check ((state in ('refused')) <= (settled_at is not null)) not valid,
  add constraint dispatch_outbox_use_decision_fk foreign key (tenant_id, use_decision_id)
    references knowledge_verification.use_decision (tenant_id, use_decision_id) on delete restrict;
create index dispatch_outbox_decision_idx on knowledge_verification.dispatch_outbox (tenant_id, use_decision_id) where use_decision_id is not null;
create index dispatch_outbox_target_idx on knowledge_verification.dispatch_outbox (tenant_id, target_binding, available_at) where state in ('pending', 'dispatched');
comment on column knowledge_verification.dispatch_outbox.marker_scheme is
  'How the acknowledgment digest is verified. ks-intent-marker.v1: expected_marker_digest is computed at enqueue (intent_marker_digest) and the ack must equal it. bks-intent-marker-digest.v1 (BKS SV-11): the ack record carries payloadDigest (= payload_digest) and planDigest, and the ack digest must equal sha256 of the JCS bytes {"format":"bks-intent-marker-digest.v1","payloadDigest":...,"planDigest":...}. The dispatch payload itself is an inline artifact_custody row whose digest equals payload_digest.';

create or replace function knowledge_verification.intent_marker_digest(
  p_tenant uuid, p_dispatch_id text, p_effect_key text, p_bound_effect_digest text, p_use_decision_id text, p_revocation_epoch bigint
) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select 'sha256:' || encode(sha256(convert_to(concat_ws(E'\n', 'ks-intent-marker.v1', p_tenant::text, p_dispatch_id, p_effect_key,
         p_bound_effect_digest, p_use_decision_id, p_revocation_epoch::text), 'UTF8')), 'hex')
$$;

-- BKS marker digest: JCS of a three-member object whose members are ASCII digests/labels (no escaping needed).
create or replace function knowledge_verification.bks_marker_digest(p_payload_digest text, p_plan_digest text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select case when p_payload_digest ~ '^sha256:[0-9a-f]{64}$' and p_plan_digest ~ '^sha256:[0-9a-f]{64}$' then
    'sha256:' || encode(sha256(convert_to('{"format":"bks-intent-marker-digest.v1","payloadDigest":"' || p_payload_digest
      || '","planDigest":"' || p_plan_digest || '"}', 'UTF8')), 'hex') end
$$;

create or replace function knowledge_verification.enqueue_dispatch(
  p_tenant uuid, p_dispatch_id text, p_effect_key text, p_target_binding text, p_payload_digest text,
  p_use_decision_id text, p_bound_effect_digest text, p_processed_epoch bigint, p_normalized_values_digest text default null,
  p_marker_scheme text default 'ks-intent-marker.v1'
) returns knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare e knowledge_verification.effect; a record; row_ knowledge_verification.dispatch_outbox;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if p_marker_scheme not in ('ks-intent-marker.v1', 'bks-intent-marker-digest.v1') then
    raise exception 'MARKER_SCHEME_UNKNOWN' using errcode = 'invalid_parameter_value';
  end if;
  select * into e from knowledge_verification.effect x where x.tenant_id = p_tenant and x.effect_key = p_effect_key;
  if not found then
    raise exception 'UNRESOLVED_EFFECT' using errcode = 'foreign_key_violation', detail = 'bind_effect before enqueueing a dispatch';
  end if;
  if e.bound_effect_digest <> p_bound_effect_digest then
    raise exception 'EFFECT_CONFLICT' using errcode = 'unique_violation', detail = 'the effect key is bound to other bytes';
  end if;
  if not exists (select 1 from knowledge_verification.artifact_custody c
                  where c.tenant_id = p_tenant and c.digest = p_payload_digest and c.custody_kind = 'inline') then
    raise exception 'PAYLOAD_NOT_IN_CUSTODY' using errcode = 'foreign_key_violation',
      detail = 'the dispatch payload is an inline artifact_custody row with digest = payload_digest';
  end if;
  select * into a from knowledge_verification.admit_exact_use(p_tenant, p_use_decision_id, p_bound_effect_digest, p_processed_epoch,
                                                               now(), p_normalized_values_digest);
  if a.outcome is distinct from 'admitted' then
    raise exception 'DISPATCH_NOT_ADMITTED' using errcode = 'integrity_constraint_violation',
      detail = format('%s/%s', coalesce(a.outcome, '<none>'), coalesce(a.reason, '<none>'));
  end if;
  insert into knowledge_verification.dispatch_outbox
    (tenant_id, dispatch_id, effect_key, target_binding, payload_digest, bound_effect_digest, use_decision_id, revocation_epoch,
     marker_scheme, expected_marker_digest)
  values (p_tenant, p_dispatch_id, p_effect_key, p_target_binding, p_payload_digest, p_bound_effect_digest, p_use_decision_id,
          a.authoritative_epoch, p_marker_scheme,
          case when p_marker_scheme = 'ks-intent-marker.v1' then
            knowledge_verification.intent_marker_digest(p_tenant, p_dispatch_id, p_effect_key, p_bound_effect_digest, p_use_decision_id,
                                                        a.authoritative_epoch) end)
  on conflict (tenant_id, dispatch_id) do nothing
  returning * into row_;
  if row_ is null then
    select * into row_ from knowledge_verification.dispatch_outbox o where o.tenant_id = p_tenant and o.dispatch_id = p_dispatch_id;
    if row_.effect_key <> p_effect_key or row_.bound_effect_digest is distinct from p_bound_effect_digest
       or row_.use_decision_id is distinct from p_use_decision_id or row_.payload_digest <> p_payload_digest
       or row_.target_binding <> p_target_binding or row_.marker_scheme is distinct from p_marker_scheme then
      raise exception 'DISPATCH_CONFLICT' using errcode = 'unique_violation', detail = 'the dispatch id names another dispatch';
    end if;
  end if;
  return row_;
end $$;
comment on function knowledge_verification.enqueue_dispatch(uuid, text, text, text, text, text, text, bigint, text, text) is
  'The only enqueue path (2.2.0): the effect is bound to the same digest, the payload is an inline custody row with that digest, and admit_exact_use admits the decision now; records the authoritative epoch and the marker scheme. Idempotent by dispatch id.';

-- Claims (optionally for one target binding) first revoke dispatches whose decision was invalidated or superseded.
drop function knowledge_verification.claim_dispatches(uuid, integer, timestamptz);
create or replace function knowledge_verification.claim_dispatches(
  p_tenant uuid, p_limit integer, p_now timestamptz default now(), p_target_binding text default null
) returns setof knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  update knowledge_verification.dispatch_outbox o set state = 'revoked', last_error = 'decision invalidated or superseded'
   where o.tenant_id = p_tenant and o.state in ('pending', 'dispatched') and o.use_decision_id is not null
     and (p_target_binding is null or o.target_binding = p_target_binding)
     and (exists (select 1 from knowledge_verification.invalidation_affected ia
                   where ia.tenant_id = p_tenant and ia.affected_kind = 'use_decision' and ia.affected_id = o.use_decision_id)
          or exists (select 1 from knowledge_verification.use_decision s
                      where s.tenant_id = p_tenant and s.supersedes_use_decision_id = o.use_decision_id));
  return query
    update knowledge_verification.dispatch_outbox o
       set state = 'dispatched', attempts = o.attempts + 1, dispatched_at = p_now, available_at = p_now + interval '60 seconds'
     where (o.tenant_id, o.dispatch_id) in (
       select c.tenant_id, c.dispatch_id from knowledge_verification.dispatch_outbox c
        where c.tenant_id = p_tenant and c.state in ('pending', 'dispatched') and c.available_at <= p_now
          and (p_target_binding is null or c.target_binding = p_target_binding)
        order by c.available_at
        limit greatest(1, least(p_limit, 100))
        for update skip locked)
    returning o.*;
end $$;

-- Verified acknowledgment, only from `dispatched`, with the acknowledgment record stored in PostgreSQL.
drop function knowledge_verification.acknowledge_dispatch(uuid, text, text, timestamptz);
create or replace function knowledge_verification.acknowledge_dispatch(
  p_tenant uuid, p_dispatch_id text, p_ack_digest text, p_now timestamptz default now(), p_ack_record jsonb default null
) returns knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.dispatch_outbox; expected text; outcome_ text;
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
      detail = 'the decision was revoked while in transit; settle the dispatch as revoked (settle_dispatch)';
  end if;
  if row_.state <> 'dispatched' then
    raise exception 'DISPATCH_NOT_DISPATCHED' using errcode = 'integrity_constraint_violation',
      detail = format('acknowledgment requires state dispatched, not %s', row_.state);
  end if;
  expected := case row_.marker_scheme
    when 'ks-intent-marker.v1' then row_.expected_marker_digest
    when 'bks-intent-marker-digest.v1' then
      case when p_ack_record ->> 'payloadDigest' = row_.payload_digest
           then knowledge_verification.bks_marker_digest(p_ack_record ->> 'payloadDigest', p_ack_record ->> 'planDigest') end
  end;
  if row_.marker_scheme is null then
    raise exception 'MARKER_SCHEME_UNKNOWN' using errcode = 'integrity_constraint_violation',
      detail = 'a dispatch enqueued before 2.2.0 has no marker scheme; it cannot be acknowledged as current';
  end if;
  if expected is null or p_ack_digest is distinct from expected then
    raise exception 'MARKER_MISMATCH' using errcode = 'integrity_constraint_violation',
      detail = format('the acknowledged native marker digest does not verify under %s', row_.marker_scheme);
  end if;
  outcome_ := coalesce(p_ack_record ->> 'outcome', 'applied');
  if outcome_ not in ('applied', 'noop') then
    raise exception 'ACK_OUTCOME_UNSUPPORTED' using errcode = 'invalid_parameter_value',
      detail = 'an acknowledgment reports applied or noop; a not-applied dispatch is settled (settle_dispatch)';
  end if;
  update knowledge_verification.dispatch_outbox
     set state = 'acknowledged', acknowledged_at = p_now, ack_digest = p_ack_digest, last_error = null,
         ack_outcome = outcome_, ack_record = coalesce(p_ack_record, '{}'::jsonb), graph_tx_ref = p_ack_record ->> 'graphTxRef'
   where tenant_id = p_tenant and dispatch_id = p_dispatch_id returning * into row_;
  return row_;
end $$;

-- Terminal not-applied settlement for the outbox worker (the target saw a revoked decision, or refused the intent).
create or replace function knowledge_verification.settle_dispatch(
  p_tenant uuid, p_dispatch_id text, p_outcome text, p_detail jsonb, p_now timestamptz default now()
) returns knowledge_verification.dispatch_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare row_ knowledge_verification.dispatch_outbox;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if p_outcome not in ('revoked', 'refused') then
    raise exception 'SETTLE_OUTCOME_UNSUPPORTED' using errcode = 'invalid_parameter_value';
  end if;
  if p_detail is null or jsonb_typeof(p_detail) <> 'object' then
    raise exception 'SETTLE_DETAIL_REQUIRED' using errcode = 'invalid_parameter_value';
  end if;
  select * into row_ from knowledge_verification.dispatch_outbox o where o.tenant_id = p_tenant and o.dispatch_id = p_dispatch_id for update;
  if not found then
    raise exception 'DISPATCH_NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if row_.state = 'acknowledged' then
    raise exception 'DISPATCH_ALREADY_ACKNOWLEDGED' using errcode = 'integrity_constraint_violation';
  end if;
  if row_.settled_at is not null then
    if row_.state is distinct from p_outcome then
      raise exception 'SETTLE_CONFLICT' using errcode = 'unique_violation';
    end if;
    return row_;  -- idempotent repeat
  end if;
  if row_.state not in ('pending', 'dispatched', 'revoked', 'failed') then
    raise exception 'DISPATCH_NOT_SETTLEABLE' using errcode = 'integrity_constraint_violation';
  end if;
  update knowledge_verification.dispatch_outbox
     set state = p_outcome, settled_at = p_now, settle_detail = p_detail, last_error = left(coalesce(p_detail ->> 'reason', p_outcome), 2000)
   where tenant_id = p_tenant and dispatch_id = p_dispatch_id returning * into row_;
  return row_;
end $$;
comment on function knowledge_verification.settle_dispatch(uuid, text, text, jsonb, timestamptz) is
  'Terminal not-applied outcome for the outbox worker (2.2.0): revoked (the decision was not current at the target) or refused (the target refused the intent). Idempotent; an acknowledged dispatch cannot be settled.';

create or replace function knowledge_verification.revoke_dispatches_of_invalidated() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.affected_kind = 'use_decision' then
    update knowledge_verification.dispatch_outbox set state = 'revoked', last_error = 'decision invalidated by correction'
     where tenant_id = new.tenant_id and use_decision_id = new.affected_id and state in ('pending', 'dispatched');
  end if;
  return new;
end $$;
create trigger invalidation_affected_revokes_dispatch after insert on knowledge_verification.invalidation_affected
  for each row execute function knowledge_verification.revoke_dispatches_of_invalidated();

-- Dependency edge direction (one reading for SQL and research-core `invalidate`): `from` is the upstream record and
-- `to` depends on it (capture -> fragment -> support set -> assertion -> report -> use decision -> effect).
comment on table knowledge_verification.dependency_edge is
  'Append-only dependency edges used by invalidation closure (2.2.0 reading): from is the upstream record, to depends on it.';

-- ---------------------------------------------------------------------------------------------------------------
-- Grants (2.2.0). The writer loses direct outbox inserts; enqueue_dispatch is the path.
-- ---------------------------------------------------------------------------------------------------------------
grant select on knowledge_verification.seal_signing_key to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
revoke insert on knowledge_verification.dispatch_outbox from knowledge_verification_writer;
grant execute on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text, text, bytea, jsonb)
  to knowledge_verification_writer;
grant execute on function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz, text),
  knowledge_verification.enqueue_dispatch(uuid, text, text, text, text, text, text, bigint, text, text) to knowledge_verification_writer;
grant execute on function knowledge_verification.check_use_eligibility(uuid, text, text, timestamptz) to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant execute on function knowledge_verification.claim_dispatches(uuid, integer, timestamptz, text),
  knowledge_verification.acknowledge_dispatch(uuid, text, text, timestamptz, jsonb),
  knowledge_verification.settle_dispatch(uuid, text, text, jsonb, timestamptz) to
  knowledge_verification_outbox_worker, knowledge_verification_writer;
grant execute on function knowledge_verification.normalized_values_valid(jsonb),
  knowledge_verification.grant_covers(jsonb, text, text, text),
  knowledge_verification.intent_marker_digest(uuid, text, text, text, text, bigint),
  knowledge_verification.bks_marker_digest(text, text) to
  knowledge_verification_reader, knowledge_verification_writer, knowledge_verification_reviewer, knowledge_verification_outbox_worker;
grant execute on function knowledge_verification.decision_scope(uuid, text) to
  knowledge_verification_writer, knowledge_verification_reviewer;
revoke all on function knowledge_verification.seal_run(uuid, uuid, text, text, jsonb, text, jsonb, text, text, text, bytea, jsonb),
  knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz, text),
  knowledge_verification.exact_use_rule(uuid, text, text, bigint, timestamptz, text, bigint),
  knowledge_verification.check_use_eligibility(uuid, text, text, timestamptz),
  knowledge_verification.enqueue_dispatch(uuid, text, text, text, text, text, text, bigint, text, text),
  knowledge_verification.claim_dispatches(uuid, integer, timestamptz, text),
  knowledge_verification.acknowledge_dispatch(uuid, text, text, timestamptz, jsonb),
  knowledge_verification.settle_dispatch(uuid, text, text, jsonb, timestamptz),
  knowledge_verification.decision_scope(uuid, text),
  knowledge_verification.seal_signing_key_guard(), knowledge_verification.revoke_dispatches_of_invalidated() from public;
