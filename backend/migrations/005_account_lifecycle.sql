BEGIN;

ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- The plaintext secret is carried only by the email link. Never store it in an
-- outbox, JSON response, audit record or request log.
CREATE TABLE account_action_tokens (
 token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
 user_id uuid NOT NULL REFERENCES users(id),
 purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 revoked_at timestamptz,
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
 CHECK (purpose<>'reset_password' OR expires_at<=created_at+interval '30 minutes')
);
CREATE UNIQUE INDEX account_action_one_pending ON account_action_tokens(user_id,purpose)
 WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX account_action_expiry ON account_action_tokens(expires_at);

ALTER TABLE auth_rate_limits DROP CONSTRAINT auth_rate_limits_scope_check;
ALTER TABLE auth_rate_limits ADD CONSTRAINT auth_rate_limits_scope_check
 CHECK (scope IN ('auth_ip','login_account','account_mail','account_reauth'));

-- Deletion and active participation lock the same user row. A concurrent join
-- or guide assignment must finish before the deletion checks, or observe the
-- tombstone and fail. Foreign keys alone do not enforce this invariant.
CREATE FUNCTION account_active_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inactive boolean;
BEGIN
 IF NEW.status IN ('confirmed','checked_in','completed') THEN
  SELECT disabled OR deleted_at IS NOT NULL INTO inactive FROM users WHERE id=NEW.user_id FOR SHARE;
  IF inactive IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'account unavailable for participation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_membership_guard BEFORE INSERT OR UPDATE OF user_id,status ON memberships
 FOR EACH ROW EXECUTE FUNCTION account_active_membership_guard();

CREATE FUNCTION account_active_departure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inactive boolean;
BEGIN
 IF NEW.status IN ('recruiting','ready','awaiting_guide','in_progress') AND NEW.guide_id IS NOT NULL THEN
  SELECT disabled OR deleted_at IS NOT NULL INTO inactive FROM users WHERE id=NEW.guide_id FOR SHARE;
  IF inactive IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'assigned guide account unavailable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status IN ('recruiting','ready','awaiting_guide','in_progress') THEN
  SELECT disabled OR deleted_at IS NOT NULL INTO inactive FROM users WHERE id=NEW.created_by FOR SHARE;
  IF inactive IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'departure creator unavailable' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_departure_guard BEFORE INSERT OR UPDATE OF guide_id,created_by,status ON departures
 FOR EACH ROW EXECUTE FUNCTION account_active_departure_guard();

CREATE FUNCTION account_recruitment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inactive boolean;
BEGIN
 IF NEW.status='open' THEN
  SELECT disabled OR deleted_at IS NOT NULL INTO inactive FROM users WHERE id=NEW.created_by FOR SHARE;
  IF inactive IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'recruitment creator unavailable' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_recruitment_owner_guard BEFORE INSERT OR UPDATE OF created_by,status ON recruitment_requests
 FOR EACH ROW EXECUTE FUNCTION account_recruitment_guard();

-- An account tombstone is permanent. Access and guide qualification history
-- remain available to authorised operators; public identity/credentials do not.
CREATE FUNCTION account_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND (
   NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NOT NEW.disabled
   OR NEW.email IS DISTINCT FROM OLD.email OR NEW.display_name IS DISTINCT FROM OLD.display_name
   OR NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.email_verified
   OR NEW.role<>'tourist' OR NEW.guide_status<>'none') THEN
  RAISE EXCEPTION 'deleted account cannot be restored' USING ERRCODE='23514';
 END IF;
 IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM memberships m JOIN departures d ON d.id=m.departure_id
    WHERE m.user_id=NEW.id AND m.status IN ('confirmed','checked_in','completed')
    AND d.status IN ('recruiting','ready','awaiting_guide','in_progress'))
   OR EXISTS(SELECT 1 FROM departures WHERE (guide_id=NEW.id OR created_by=NEW.id) AND status IN ('recruiting','ready','awaiting_guide','in_progress'))
   OR EXISTS(SELECT 1 FROM recruitment_requests WHERE created_by=NEW.id AND status='open') THEN
   RAISE EXCEPTION 'account has active commitments' USING ERRCODE='23514';
  END IF;
  IF NOT NEW.disabled OR NEW.email<>'deleted-'||NEW.id::text||'@account.invalid'
   OR NEW.display_name<>'Удалённый аккаунт' OR NEW.password_hash<>'!deleted'
   OR NEW.email_verified OR NEW.role<>'tourist' OR NEW.guide_status<>'none' THEN
   RAISE EXCEPTION 'incomplete account tombstone' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_tombstone_guard BEFORE UPDATE ON users
 FOR EACH ROW EXECUTE FUNCTION account_tombstone_guard();

INSERT INTO schema_migrations(version) VALUES(5);
COMMIT;
