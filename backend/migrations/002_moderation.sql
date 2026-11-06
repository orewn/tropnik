BEGIN;
ALTER TABLE users ADD COLUMN is_moderator boolean NOT NULL DEFAULT false;
ALTER TABLE departures ADD COLUMN completed_at timestamptz;
UPDATE departures d SET completed_at=(SELECT min(a.created_at) FROM audit_events a WHERE a.entity_id=d.id AND a.action='departure.complete') WHERE d.status='completed';
ALTER TABLE messages ADD COLUMN visibility text NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','hidden'));
ALTER TABLE recruitment_messages ADD COLUMN visibility text NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','hidden'));
ALTER TABLE reviews ADD COLUMN visibility text NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','hidden'));

CREATE TABLE posting_guards (
 user_id uuid PRIMARY KEY REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE submission_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('message','review','recruitment','report')), channel text NOT NULL,
 fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_user_time ON submission_events(user_id,created_at);
CREATE INDEX submission_user_fingerprint ON submission_events(user_id,fingerprint,created_at);

CREATE TABLE reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_id uuid NOT NULL REFERENCES users(id),
 subject_id uuid NOT NULL REFERENCES users(id), target_type text NOT NULL CHECK(target_type IN ('message','recruitment_message','review')),
 target_id uuid NOT NULL, reason text NOT NULL CHECK(reason IN ('spam','harassment','dangerous_information','personal_data','other')),
 body text NOT NULL CHECK(char_length(body) BETWEEN 10 AND 2000), status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by uuid REFERENCES users(id),
 decision_reason text CHECK(char_length(decision_reason) BETWEEN 10 AND 2000),
 UNIQUE(reporter_id,target_type,target_id), CHECK(reporter_id<>subject_id),
 CHECK((status='open' AND resolved_at IS NULL AND resolved_by IS NULL AND decision_reason IS NULL) OR (status<>'open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE INDEX reports_queue ON reports(status,created_at);
CREATE TABLE moderation_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), report_id uuid NOT NULL UNIQUE REFERENCES reports(id),
 subject_id uuid NOT NULL REFERENCES users(id), actor_id uuid NOT NULL REFERENCES users(id),
 target_type text NOT NULL CHECK(target_type IN ('message','recruitment_message','review')), target_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('hide','mute','hide_and_mute')), reason text NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, revoked_at timestamptz,
 CHECK(actor_id<>subject_id), CHECK((action='hide' AND expires_at IS NULL) OR (action<>'hide' AND expires_at IS NOT NULL AND expires_at>created_at))
);
CREATE INDEX active_mutes ON moderation_actions(subject_id,expires_at) WHERE revoked_at IS NULL AND action IN ('mute','hide_and_mute');
CREATE TABLE appeals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action_id uuid NOT NULL UNIQUE REFERENCES moderation_actions(id),
 user_id uuid NOT NULL REFERENCES users(id), body text NOT NULL CHECK(char_length(body) BETWEEN 10 AND 2000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','upheld','overturned')), created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz, decided_by uuid REFERENCES users(id), decision_reason text CHECK(char_length(decision_reason) BETWEEN 10 AND 2000),
 CHECK((status='open' AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL) OR (status<>'open' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE INDEX appeals_queue ON appeals(status,created_at);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('moderation','appeal','report')), title text NOT NULL, body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX notification_recipient ON notifications(user_id,created_at);
INSERT INTO schema_migrations(version) VALUES(2);
COMMIT;
