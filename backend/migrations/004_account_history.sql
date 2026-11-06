BEGIN;
-- The history query scopes by account before ordering completed departures.
-- No participant list or new access privilege is introduced by these indexes.
CREATE INDEX membership_completed_account ON memberships(user_id,departure_id) WHERE status='completed';
CREATE INDEX departure_completed_history ON departures(completed_at DESC,id DESC) WHERE status='completed' AND completed_at IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(4);
COMMIT;
