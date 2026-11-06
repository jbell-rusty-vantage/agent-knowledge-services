-- knowledge_verification 2.4.0 / 0007_server_clock_and_required_values_digest
-- Sprint V follow-up to the R1 review (2026-10-25):
--   1. F2. The exact-use write path no longer fails open on the normalized values: admit_exact_use (and so
--      enqueue_dispatch, which admits through it) raises NORMALIZED_VALUES_REQUIRED when the decision binds a
--      normalized-values digest and the caller presents none. check_use_eligibility (official reads) keeps comparing
--      no values. The parameter default stays only so the 2.2.0 call shapes still resolve; a caller that omits the
--      digest now gets the refusal instead of an admission.
--   2. F15. Clocks are the server's. consume_credential and purge_credential_use take no caller time; the 2.3.0
--      six- and two-argument shapes remain for existing callers and ignore the time they pass. admit_exact_use also
--      evaluates expiry and grant revocation at the server's now(): its p_now argument is ignored for the same reason.
-- The installer wraps this file in its transaction. No BEGIN/COMMIT here.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Exact-use admission: the normalized-values digest is required whenever the decision binds one (F2), and the
--    rule runs at the server clock (F15).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function knowledge_verification.admit_exact_use(
  p_tenant uuid, p_use_decision_id text, p_bound_effect_digest text, p_processed_epoch bigint,
  p_now timestamptz default now(), p_normalized_values_digest text default null
) returns table (outcome text, reason text, authoritative_epoch bigint)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare auth bigint;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if p_normalized_values_digest is null and exists (
    select 1 from knowledge_verification.use_decision u
     where u.tenant_id = p_tenant and u.use_decision_id = p_use_decision_id and u.normalized_values_digest is not null
  ) then
    raise exception 'NORMALIZED_VALUES_REQUIRED' using errcode = 'null_value_not_allowed',
      detail = 'the decision binds normalized values; a writer presents their digest (check_use_eligibility is the read path)';
  end if;
  -- Lock the epoch row so a concurrent advance serializes against this admission (held until the caller commits).
  insert into knowledge_verification.revocation_epoch (tenant_id, epoch, reason) values (p_tenant, 0, 'initial') on conflict do nothing;
  select e.epoch into auth from knowledge_verification.revocation_epoch e where e.tenant_id = p_tenant for share;
  return query select r.outcome, r.reason, r.authoritative_epoch
    from knowledge_verification.exact_use_rule(p_tenant, p_use_decision_id, p_bound_effect_digest, p_processed_epoch, now(),
                                               p_normalized_values_digest, auth) r;
end $$;
comment on function knowledge_verification.admit_exact_use(uuid, text, text, bigint, timestamptz, text) is
  'Exact-use admission under the epoch lock (2.4.0): exact effect digest, the normalized values digest (required when the decision binds one: NORMALIZED_VALUES_REQUIRED), unexpired at the server clock (p_now is ignored), not superseded/invalidated, processed_epoch >= authoritative, closure complete, and a live in-scope approving adjudication for review-conditioned decisions (exact_use_rule). Call it on the native transaction''s own connection.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Single-use credentials at the server clock (F15). The 2.3.0 shape had a defaulted p_now; it is replaced by an
--    exact five-argument form plus a six-argument compatibility form without a default (no ambiguous call).
-- ---------------------------------------------------------------------------------------------------------------
drop function knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz);
create function knowledge_verification.consume_credential(
  p_tenant uuid, p_issuer text, p_jti text, p_dispatch_id text, p_expires_at timestamptz
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare inserted integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  if p_expires_at <= now() then
    return 'expired';
  end if;
  insert into knowledge_verification.credential_use (tenant_id, issuer, jti, dispatch_id, expires_at, consumed_at)
  values (p_tenant, p_issuer, p_jti, p_dispatch_id, p_expires_at, now())
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
comment on function knowledge_verification.consume_credential(uuid, text, text, text, timestamptz) is
  'Consume one credential at the server clock (2.4.0): consumed | replay (jti already used) | dispatch_reused (dispatch id carried by another credential) | expired. Concurrent consumers of one jti: exactly one sees consumed.';

create function knowledge_verification.consume_credential(
  p_tenant uuid, p_issuer text, p_jti text, p_dispatch_id text, p_expires_at timestamptz, p_now timestamptz
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  return knowledge_verification.consume_credential(p_tenant, p_issuer, p_jti, p_dispatch_id, p_expires_at);
end $$;
comment on function knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz) is
  '2.3.0 call shape, kept for existing callers: the caller time p_now is ignored; the server clock decides (F15).';

drop function knowledge_verification.purge_credential_use(uuid, timestamptz);
create function knowledge_verification.purge_credential_use(p_tenant uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare removed integer;
begin
  perform knowledge_verification.assert_tenant(p_tenant);
  delete from knowledge_verification.credential_use u where u.tenant_id = p_tenant and u.expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end $$;
comment on function knowledge_verification.purge_credential_use(uuid) is
  'Remove consumed-credential rows whose expiry has passed at the server clock (2.4.0); unexpired nonces are never removed.';

create function knowledge_verification.purge_credential_use(p_tenant uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  return knowledge_verification.purge_credential_use(p_tenant);
end $$;
comment on function knowledge_verification.purge_credential_use(uuid, timestamptz) is
  '2.3.0 call shape, kept for existing callers: the caller time p_now is ignored; the server clock decides (F15).';

-- ---------------------------------------------------------------------------------------------------------------
-- Grants (2.4.0). Rows are still written only through the definer functions.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function
  knowledge_verification.consume_credential(uuid, text, text, text, timestamptz),
  knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz),
  knowledge_verification.purge_credential_use(uuid),
  knowledge_verification.purge_credential_use(uuid, timestamptz) from public;
grant execute on function
  knowledge_verification.consume_credential(uuid, text, text, text, timestamptz),
  knowledge_verification.consume_credential(uuid, text, text, text, timestamptz, timestamptz),
  knowledge_verification.purge_credential_use(uuid),
  knowledge_verification.purge_credential_use(uuid, timestamptz) to knowledge_verification_writer;
