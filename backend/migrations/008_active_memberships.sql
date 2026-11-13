BEGIN;

-- Public departure counts must not scan withdrawn/no-show membership history.
-- Transactional CREATE INDEX blocks table writes until commit. Schedule this
-- migration in a maintenance window on an already populated large database.
CREATE INDEX memberships_active_departure ON memberships(departure_id)
 WHERE status IN ('confirmed','checked_in','completed');

INSERT INTO schema_migrations(version) VALUES(8);
COMMIT;
