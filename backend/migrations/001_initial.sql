BEGIN;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK (length(email)<=254 AND email=lower(email)),
 password_hash text NOT NULL, display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 80),
 role text NOT NULL DEFAULT 'tourist' CHECK (role IN ('tourist','guide')),
 guide_status text NOT NULL DEFAULT 'none' CHECK (guide_status IN ('none','pending','verified','suspended','expired')),
 email_verified boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
 is_admin boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE guide_qualifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 activity text NOT NULL, max_difficulty integer NOT NULL CHECK (max_difficulty BETWEEN 1 AND 4),
 valid_until timestamptz NOT NULL, evidence_ref text NOT NULL CHECK (length(evidence_ref)>5),
 verified_by uuid NOT NULL REFERENCES users(id), verified_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX guide_qualification_lookup ON guide_qualifications(user_id,activity,valid_until);
CREATE TABLE regions (
 id text PRIMARY KEY, title text NOT NULL, description text NOT NULL,
 center geometry(Point,4326) NOT NULL, bounds jsonb NOT NULL CHECK (jsonb_array_length(bounds)=4)
);
CREATE TABLE routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, region_id text NOT NULL REFERENCES regions(id),
 title text NOT NULL, description text NOT NULL, activity text NOT NULL DEFAULT 'hiking',
 status text NOT NULL DEFAULT 'review_required' CHECK (status IN ('draft','review_required','published','closed')),
 current_revision_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE route_regions (route_id uuid REFERENCES routes(id), region_id text REFERENCES regions(id), PRIMARY KEY(route_id,region_id));
CREATE TABLE route_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), route_id uuid NOT NULL REFERENCES routes(id), revision integer NOT NULL CHECK(revision>0),
 geometry geometry(LineString,4326) NOT NULL CHECK (ST_NPoints(geometry)>=2 AND ST_NPoints(geometry)<=100000 AND NOT ST_IsEmpty(geometry)),
 distance_km double precision NOT NULL CHECK(distance_km>0 AND distance_km<10000),
 ascent_m integer NOT NULL CHECK(ascent_m>=0 AND ascent_m<100000), duration_min integer NOT NULL CHECK(duration_min>0 AND duration_min<100000),
 difficulty text NOT NULL CHECK(difficulty IN ('easy','moderate','hard','expert')), season text NOT NULL,
 min_people integer NOT NULL DEFAULT 4 CHECK(min_people>=4), max_group_size integer NOT NULL DEFAULT 8 CHECK(max_group_size>=min_people AND max_group_size<=50), required_guides integer NOT NULL DEFAULT 1 CHECK(required_guides>=1 AND required_guides<=max_group_size),
 source_name text NOT NULL, source_url text NOT NULL CHECK(source_url ~ '^https://'), source_license text NOT NULL,
 source_retrieved_at timestamptz NOT NULL, reviewed_at timestamptz, reviewed_by uuid REFERENCES users(id), review_evidence text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(route_id,revision), UNIQUE(route_id,id),
 CHECK ((reviewed_at IS NULL AND reviewed_by IS NULL) OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review_evidence IS NOT NULL AND length(review_evidence)>5))
);
ALTER TABLE routes ADD CONSTRAINT current_route_revision FOREIGN KEY (id,current_revision_id) REFERENCES route_revisions(route_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX route_geometry ON route_revisions USING gist(geometry);
CREATE TABLE departures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), route_id uuid NOT NULL REFERENCES routes(id), route_revision_id uuid NOT NULL,
 guide_id uuid REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id), starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL CHECK(ends_at>starts_at), time_zone text NOT NULL,
 min_people integer NOT NULL DEFAULT 4 CHECK(min_people>=4), capacity integer NOT NULL CHECK(capacity>=min_people AND capacity<=50),
 status text NOT NULL DEFAULT 'recruiting' CHECK(status IN ('recruiting','ready','awaiting_guide','in_progress','completed','cancelled','aborted')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(route_id,route_revision_id) REFERENCES route_revisions(route_id,id)
);
CREATE INDEX departures_upcoming ON departures(starts_at) WHERE status IN ('recruiting','ready');
CREATE FUNCTION check_departure_route_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p route_revisions%ROWTYPE;
BEGIN
 SELECT * INTO p FROM route_revisions WHERE id=NEW.route_revision_id AND route_id=NEW.route_id;
 IF p.id IS NULL OR p.required_guides<>1 OR NEW.min_people<p.min_people OR NEW.capacity>p.max_group_size THEN
  RAISE EXCEPTION 'departure violates reviewed route group policy' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER departure_route_policy_guard BEFORE INSERT OR UPDATE OF route_revision_id,min_people,capacity ON departures FOR EACH ROW EXECUTE FUNCTION check_departure_route_policy();
CREATE TABLE memberships (
 departure_id uuid NOT NULL REFERENCES departures(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('tourist','guide')),
 status text NOT NULL CHECK(status IN ('confirmed','checked_in','completed','cancelled','no_show')),
 joined_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(departure_id,user_id)
);
CREATE UNIQUE INDEX one_assigned_guide ON memberships(departure_id) WHERE role='guide' AND status IN ('confirmed','checked_in','completed');
CREATE TABLE idempotency_keys (
 user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL CHECK(length(key) BETWEEN 16 AND 128),
 operation text NOT NULL, request_hash bytea NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,key)
);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), departure_id uuid NOT NULL REFERENCES departures(id), user_id uuid NOT NULL REFERENCES users(id),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000), client_id text NOT NULL CHECK(length(client_id) BETWEEN 16 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,client_id)
);
CREATE INDEX messages_feed ON messages(departure_id,created_at,id);
CREATE TABLE reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), departure_id uuid NOT NULL REFERENCES departures(id), user_id uuid NOT NULL REFERENCES users(id),
 target text NOT NULL CHECK(target IN ('guide','route')), rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 3000), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(departure_id,user_id,target)
);
CREATE TABLE offline_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), client_id text NOT NULL,
 departure_id uuid NOT NULL REFERENCES departures(id), base_version bigint NOT NULL, observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL CHECK(kind IN ('field_note','check_in_observation')),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000), request_hash bytea NOT NULL,
 acknowledgement jsonb NOT NULL, UNIQUE(user_id,client_id)
);
CREATE TABLE outbox_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, aggregate_id uuid NOT NULL,
 event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(id) WHERE processed_at IS NULL;
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
 entity_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recruitment_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), route_id uuid NOT NULL REFERENCES routes(id), created_by uuid NOT NULL REFERENCES users(id),
 preferred_date date, body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','cancelled')),
 departure_id uuid REFERENCES departures(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recruitment_open ON recruitment_requests(route_id,created_at) WHERE status='open';
CREATE UNIQUE INDEX recruitment_one_open_per_creator ON recruitment_requests(route_id,created_by) WHERE status='open';
CREATE TABLE recruitment_members (request_id uuid REFERENCES recruitment_requests(id), user_id uuid REFERENCES users(id), joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(request_id,user_id));
CREATE TABLE recruitment_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES recruitment_requests(id), user_id uuid NOT NULL REFERENCES users(id),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000), client_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,client_id)
);
CREATE FUNCTION immutable_reviewed_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'reviewed route revisions are immutable; create another revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER route_revision_immutable BEFORE UPDATE ON route_revisions FOR EACH ROW EXECUTE FUNCTION immutable_reviewed_revision();
CREATE FUNCTION check_route_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='published' AND NOT EXISTS(SELECT 1 FROM route_revisions WHERE id=NEW.current_revision_id AND route_id=NEW.id AND reviewed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'published route requires a reviewed revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER route_publication_guard BEFORE INSERT OR UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION check_route_publication();
CREATE FUNCTION check_membership_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer; assigned uuid; occupants integer;
BEGIN
 SELECT capacity,guide_id INTO cap,assigned FROM departures WHERE id=NEW.departure_id FOR UPDATE;
 IF NEW.status IN ('confirmed','checked_in','completed') THEN
  SELECT count(*) INTO occupants FROM memberships WHERE departure_id=NEW.departure_id AND user_id<>NEW.user_id AND status IN ('confirmed','checked_in','completed');
  IF occupants>=cap THEN RAISE EXCEPTION 'departure capacity exceeded' USING ERRCODE='23514'; END IF;
  IF NEW.role='guide' AND (assigned IS NULL OR assigned<>NEW.user_id) THEN RAISE EXCEPTION 'guide assignment mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_capacity_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION check_membership_capacity();
CREATE FUNCTION check_review_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM memberships m JOIN departures d ON d.id=m.departure_id WHERE m.departure_id=NEW.departure_id AND m.user_id=NEW.user_id AND m.status='completed' AND m.role='tourist' AND d.status='completed') THEN
  RAISE EXCEPTION 'completed participation required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER review_eligibility_guard BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION check_review_eligibility();
INSERT INTO regions(id,title,description,center,bounds) VALUES
 ('altai','Алтай','Республика Алтай. Проверенный каталог формируется отдельно от фоновой карты.',ST_SetSRID(ST_MakePoint(86.5,50.8),4326),'[83.9,49.1,89.9,52.7]'),
 ('krasnodar','Краснодарский край','Туристические районы Краснодарского края.',ST_SetSRID(ST_MakePoint(39.7,44.7),4326),'[36.5,43.3,41.8,46.9]'),
 ('karelia','Карелия','Республика Карелия.',ST_SetSRID(ST_MakePoint(33.4,63.5),4326),'[29.3,60.6,37.8,66.7]'),
 ('krym','Крым','Туристический район Крым. География обзора не подтверждает доступность маршрутов.',ST_SetSRID(ST_MakePoint(34.1,45.1),4326),'[32.4,44.3,36.7,46.3]'),
 ('baikal','Байкал','Туристический район озера Байкал; маршруты могут проходить через разные административные территории.',ST_SetSRID(ST_MakePoint(108.2,53.4),4326),'[103.5,51.1,110.3,56.1]'),
 ('kamchatka','Камчатка','Камчатский край.',ST_SetSRID(ST_MakePoint(160.0,56.4),4326),'[155.5,50.8,174.5,65.0]');
INSERT INTO schema_migrations(version) VALUES(1);
COMMIT;
