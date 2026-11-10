BEGIN;

ALTER TABLE route_revisions
 ADD COLUMN risk_class text NOT NULL DEFAULT 'standard' CHECK (risk_class IN ('standard','elevated','high','extreme')),
 ADD COLUMN route_type text NOT NULL DEFAULT 'pedestrian' CHECK (route_type IN ('pedestrian','mountain','water','ski','speleo','combined')),
 ADD COLUMN legal_difficulty_category text NOT NULL DEFAULT 'uncategorized' CHECK (char_length(legal_difficulty_category) BETWEEN 1 AND 40),
 ADD COLUMN mchs_notification_policy text NOT NULL DEFAULT 'recommended' CHECK (mchs_notification_policy IN ('not_required','recommended','required')),
 ADD COLUMN mchs_territorial_unit_id text CHECK (mchs_territorial_unit_id IS NULL OR char_length(mchs_territorial_unit_id) BETWEEN 2 AND 120),
 ADD COLUMN emergency_exits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(emergency_exits)='array'),
 ADD COLUMN control_points jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(control_points)='array'),
 ADD COLUMN default_check_in_schedule jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(default_check_in_schedule)='array'),
 ADD COLUMN safety_revision integer NOT NULL DEFAULT 1 CHECK (safety_revision>0);

ALTER TABLE guide_qualifications
 ADD COLUMN registry_number text CHECK (registry_number IS NULL OR char_length(registry_number) BETWEEN 3 AND 120),
 ADD COLUMN registry_record_url text CHECK (registry_record_url IS NULL OR registry_record_url ~ '^https://'),
 ADD COLUMN evidence_hash bytea CHECK (evidence_hash IS NULL OR octet_length(evidence_hash)=32);

CREATE TABLE departure_safety (
 departure_id uuid PRIMARY KEY REFERENCES departures(id) ON DELETE CASCADE,
 notification_policy text NOT NULL CHECK (notification_policy IN ('not_required','recommended','required')),
 status text NOT NULL CHECK (status IN ('not_required','recommended','required','preparing','ready_to_submit','submitted_unverified','start_contact_pending','confirmed','amendment_required','active','return_report_pending','closed','rejected','cancelled')),
 passport_version integer NOT NULL DEFAULT 0 CHECK (passport_version>=0),
 territorial_unit_id text,
 submission_id text CHECK (submission_id IS NULL OR char_length(submission_id) BETWEEN 3 AND 160),
 submitted_at timestamptz,
 confirmation_ref text CHECK (confirmation_ref IS NULL OR char_length(confirmation_ref) BETWEEN 3 AND 240),
 confirmation_hash bytea CHECK (confirmation_hash IS NULL OR octet_length(confirmation_hash)=32),
 confirmed_at timestamptz,
 confirmed_by uuid REFERENCES users(id),
 start_contact_due_at timestamptz NOT NULL,
 start_contact_confirmed_at timestamptz,
 return_report_due_at timestamptz NOT NULL,
 return_reported_at timestamptz,
 last_safety_change_at timestamptz NOT NULL DEFAULT now(),
 passport_hash bytea CHECK (passport_hash IS NULL OR octet_length(passport_hash)=32),
 manifest_hash bytea CHECK (manifest_hash IS NULL OR octet_length(manifest_hash)=32),
 event_sequence integer NOT NULL DEFAULT 0 CHECK (event_sequence>=0),
 event_hash bytea CHECK (event_hash IS NULL OR octet_length(event_hash)=32),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
 CHECK ((passport_version=0 AND passport_hash IS NULL) OR (passport_version>0 AND passport_hash IS NOT NULL AND manifest_hash IS NOT NULL))
);

CREATE TABLE safety_passport_versions (
 departure_id uuid NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK (version>0),
 payload_cipher bytea NOT NULL CHECK (octet_length(payload_cipher)>16),
 payload_nonce bytea NOT NULL CHECK (octet_length(payload_nonce)=12),
 public_payload jsonb NOT NULL CHECK (jsonb_typeof(public_payload)='object'),
 content_hash bytea NOT NULL CHECK (octet_length(content_hash)=32),
 manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash)=32),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(departure_id,version)
);

CREATE TABLE safety_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 departure_id uuid NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK (sequence>0),
 event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
 actor_id uuid REFERENCES users(id), payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
 previous_hash bytea CHECK (previous_hash IS NULL OR octet_length(previous_hash)=32),
 event_hash bytea NOT NULL CHECK (octet_length(event_hash)=32),
 created_at timestamptz NOT NULL,
 UNIQUE(departure_id,sequence), UNIQUE(departure_id,event_hash)
);
CREATE INDEX safety_events_feed ON safety_events(departure_id,sequence);

CREATE TABLE safety_check_ins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), departure_id uuid NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK (kind IN ('start','control_point','return','incident')),
 observed_at timestamptz NOT NULL, server_received_at timestamptz NOT NULL DEFAULT now(),
 latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
 longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
 note text NOT NULL DEFAULT '' CHECK (char_length(note)<=1000),
 CHECK ((latitude IS NULL)=(longitude IS NULL))
);
CREATE INDEX safety_check_ins_feed ON safety_check_ins(departure_id,observed_at,id);

-- One canonical representation is shared by application events and trigger events.
-- sha256(bytea) is built into PostgreSQL; no additional extension is required.
CREATE FUNCTION safety_event_body(dep uuid, seq integer, kind text, actor uuid, details jsonb, at_time timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('departureId',dep::text,'sequence',seq,'eventType',kind,
  'actor',COALESCE(actor::text,''),'payload',details,
  'createdAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text;
$$;
CREATE FUNCTION append_safety_event(dep uuid, actor uuid, kind text, details jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq integer; previous bytea; digest bytea; at_time timestamptz := clock_timestamp();
BEGIN
 SELECT event_sequence+1,event_hash INTO STRICT seq,previous FROM departure_safety WHERE departure_id=dep FOR UPDATE;
 digest := sha256(COALESCE(previous,''::bytea)||convert_to(safety_event_body(dep,seq,kind,actor,details,at_time),'UTF8'));
 INSERT INTO safety_events(departure_id,sequence,event_type,actor_id,payload,previous_hash,event_hash,created_at)
 VALUES(dep,seq,kind,actor,details,previous,digest,at_time);
 UPDATE departure_safety SET event_sequence=seq,event_hash=digest,updated_at=now() WHERE departure_id=dep;
END $$;

CREATE FUNCTION create_departure_safety_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p route_revisions%ROWTYPE;
BEGIN
 SELECT * INTO p FROM route_revisions WHERE id=NEW.route_revision_id;
 INSERT INTO departure_safety(departure_id,notification_policy,status,territorial_unit_id,start_contact_due_at,return_report_due_at)
 VALUES(NEW.id,p.mchs_notification_policy,p.mchs_notification_policy,p.mchs_territorial_unit_id,NEW.starts_at-interval '1 day',NEW.ends_at+interval '1 day')
 ON CONFLICT(departure_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER departure_safety_create AFTER INSERT ON departures FOR EACH ROW EXECUTE FUNCTION create_departure_safety_row();

INSERT INTO departure_safety(departure_id,notification_policy,status,territorial_unit_id,start_contact_due_at,return_report_due_at)
SELECT d.id,rr.mchs_notification_policy,rr.mchs_notification_policy,rr.mchs_territorial_unit_id,d.starts_at-interval '1 day',d.ends_at+interval '1 day'
FROM departures d JOIN route_revisions rr ON rr.id=d.route_revision_id
ON CONFLICT(departure_id) DO NOTHING;

CREATE FUNCTION invalidate_safety_snapshot(dep uuid, reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous_status text; current_version integer;
BEGIN
 SELECT status,passport_version INTO STRICT previous_status,current_version FROM departure_safety WHERE departure_id=dep FOR UPDATE;
 IF current_version>0 AND previous_status NOT IN ('closed','cancelled') THEN
  UPDATE departure_safety SET status='amendment_required',confirmed_at=NULL,confirmed_by=NULL,
   start_contact_confirmed_at=NULL,last_safety_change_at=now(),updated_at=now() WHERE departure_id=dep;
  PERFORM append_safety_event(dep,NULL,'passport.amendment_required',jsonb_build_object('reason',reason,'version',current_version,'previousStatus',previous_status));
 END IF;
END $$;

CREATE FUNCTION invalidate_departure_safety() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy text; unit text;
BEGIN
 SELECT mchs_notification_policy,mchs_territorial_unit_id INTO STRICT policy,unit FROM route_revisions WHERE id=NEW.route_revision_id;
 PERFORM invalidate_safety_snapshot(NEW.id,'departure_changed');
 UPDATE departure_safety SET notification_policy=policy,territorial_unit_id=unit,
  status=CASE WHEN passport_version=0 THEN policy ELSE status END,
  start_contact_due_at=NEW.starts_at-interval '1 day',return_report_due_at=NEW.ends_at+interval '1 day',
  last_safety_change_at=now(),updated_at=now() WHERE departure_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER departure_safety_invalidate AFTER UPDATE OF route_revision_id,guide_id,starts_at,ends_at,time_zone ON departures FOR EACH ROW
WHEN (OLD.route_revision_id IS DISTINCT FROM NEW.route_revision_id OR OLD.guide_id IS DISTINCT FROM NEW.guide_id OR OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at OR OLD.time_zone IS DISTINCT FROM NEW.time_zone)
EXECUTE FUNCTION invalidate_departure_safety();

CREATE FUNCTION invalidate_membership_safety() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dep uuid; old_active boolean := false; new_active boolean := false;
BEGIN
 IF TG_OP<>'INSERT' THEN old_active:=OLD.status IN ('confirmed','checked_in','completed'); END IF;
 IF TG_OP<>'DELETE' THEN new_active:=NEW.status IN ('confirmed','checked_in','completed'); END IF;
 -- Attendance and completion do not change the registered manifest. No-op UPSERTs
 -- from saveGroup must not invalidate a passport either.
 IF TG_OP='UPDATE' AND OLD.departure_id=NEW.departure_id AND OLD.user_id=NEW.user_id AND OLD.role=NEW.role AND old_active=new_active THEN RETURN NEW; END IF;
 IF NOT old_active AND NOT new_active THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 dep:=COALESCE(NEW.departure_id,OLD.departure_id);
 PERFORM 1 FROM departures WHERE id=dep FOR UPDATE;
 PERFORM invalidate_safety_snapshot(dep,'membership_changed');
 IF TG_OP='UPDATE' AND OLD.departure_id IS DISTINCT FROM NEW.departure_id AND old_active THEN
  PERFORM 1 FROM departures WHERE id=OLD.departure_id FOR UPDATE;
  PERFORM invalidate_safety_snapshot(OLD.departure_id,'membership_changed');
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER membership_safety_invalidate AFTER INSERT OR DELETE OR UPDATE OF status,role,user_id,departure_id ON memberships FOR EACH ROW EXECUTE FUNCTION invalidate_membership_safety();

CREATE FUNCTION enforce_required_safety_before_start() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s departure_safety%ROWTYPE; policy text;
BEGIN
 IF NEW.status='in_progress' AND OLD.status IS DISTINCT FROM NEW.status THEN
  SELECT * INTO s FROM departure_safety WHERE departure_id=NEW.id FOR UPDATE;
  SELECT mchs_notification_policy INTO STRICT policy FROM route_revisions WHERE id=NEW.route_revision_id;
  IF s.departure_id IS NULL THEN RAISE EXCEPTION 'departure safety state missing' USING ERRCODE='23514'; END IF;
  IF policy='required' AND (s.notification_policy IS DISTINCT FROM policy OR s.passport_version<1 OR s.status<>'confirmed' OR s.confirmed_at IS NULL OR s.confirmed_by IS NULL OR s.start_contact_confirmed_at IS NULL OR s.start_contact_confirmed_at<NEW.starts_at-interval '1 day' OR s.start_contact_confirmed_at<now()-interval '1 day' OR s.start_contact_confirmed_at>now()+interval '5 minutes' OR EXISTS(SELECT 1 FROM memberships WHERE departure_id=NEW.id AND status='confirmed')) THEN
   RAISE EXCEPTION 'required MCHS notification is not confirmed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER departure_safety_start_guard BEFORE UPDATE OF status ON departures FOR EACH ROW EXECUTE FUNCTION enforce_required_safety_before_start();

CREATE FUNCTION immutable_safety_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'safety evidence is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER safety_passport_immutable BEFORE UPDATE OR DELETE ON safety_passport_versions FOR EACH ROW EXECUTE FUNCTION immutable_safety_record();
CREATE TRIGGER safety_event_immutable BEFORE UPDATE OR DELETE ON safety_events FOR EACH ROW EXECUTE FUNCTION immutable_safety_record();
CREATE TRIGGER safety_check_in_immutable BEFORE UPDATE OR DELETE ON safety_check_ins FOR EACH ROW EXECUTE FUNCTION immutable_safety_record();

INSERT INTO schema_migrations(version) VALUES(6);
COMMIT;
