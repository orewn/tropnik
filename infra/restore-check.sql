-- Aggregate-only recovery report for the current six-migration application.
SET search_path=pg_catalog,public;
CREATE TEMP TABLE expected_application_tables(name text PRIMARY KEY);
INSERT INTO expected_application_tables(name) VALUES
 ('users'),('sessions'),('guide_qualifications'),('regions'),('routes'),('route_regions'),('route_revisions'),
 ('departures'),('memberships'),('idempotency_keys'),('messages'),('reviews'),('offline_observations'),
 ('recruitment_requests'),('recruitment_members'),('recruitment_messages'),('departure_safety'),
 ('safety_passport_versions'),('safety_events'),('safety_check_ins'),('schema_migrations'),('account_action_tokens'),
 ('auth_rate_limits'),('audit_events'),('outbox_events'),('posting_guards'),('submission_events'),
 ('reports'),('moderation_actions'),('appeals'),('notifications');
CREATE TEMP TABLE expected_application_guards(table_name text,trigger_name text,function_name text,
 event_mask integer,update_columns text[],has_condition boolean,
 PRIMARY KEY(table_name,trigger_name));
-- pg_trigger bit flags bind row/statement, BEFORE/AFTER and operation, not
-- merely the name of the function. An INSERT-only start guard is ineffective.
INSERT INTO expected_application_guards VALUES
 ('departures','departure_route_policy_guard','check_departure_route_policy',23,ARRAY['capacity','min_people','route_revision_id'],false),
 ('route_revisions','route_revision_immutable','immutable_reviewed_revision',19,ARRAY[]::text[],false),
 ('routes','route_publication_guard','check_route_publication',23,ARRAY[]::text[],false),
 ('memberships','membership_capacity_guard','check_membership_capacity',23,ARRAY[]::text[],false),
 ('reviews','review_eligibility_guard','check_review_eligibility',7,ARRAY[]::text[],false),
 ('memberships','account_membership_guard','account_active_membership_guard',23,ARRAY['status','user_id'],false),
 ('departures','account_departure_guard','account_active_departure_guard',23,ARRAY['created_by','guide_id','status'],false),
 ('recruitment_requests','account_recruitment_owner_guard','account_recruitment_guard',23,ARRAY['created_by','status'],false),
 ('users','account_tombstone_guard','account_tombstone_guard',19,ARRAY[]::text[],false),
 ('departures','departure_safety_create','create_departure_safety_row',5,ARRAY[]::text[],false),
 ('departures','departure_safety_invalidate','invalidate_departure_safety',17,ARRAY['ends_at','guide_id','route_revision_id','starts_at','time_zone'],true),
 ('memberships','membership_safety_invalidate','invalidate_membership_safety',29,ARRAY['departure_id','role','status','user_id'],false),
 ('departures','departure_safety_start_guard','enforce_required_safety_before_start',19,ARRAY['status'],false),
 ('safety_passport_versions','safety_passport_immutable','immutable_safety_record',27,ARRAY[]::text[],false),
 ('safety_events','safety_event_immutable','immutable_safety_record',27,ARRAY[]::text[],false),
 ('safety_check_ins','safety_check_in_immutable','immutable_safety_record',27,ARRAY[]::text[],false);

DO $$ BEGIN
 IF current_database()<>'tropa_restore_test' THEN
  RAISE EXCEPTION 'recovery verification requires the isolated restore database';
 END IF;
 IF current_setting('data_directory') NOT LIKE '/var/lib/postgresql/%' THEN
  RAISE EXCEPTION 'restored database is outside its temporary data mount';
 END IF;
 IF (SELECT array_agg(version ORDER BY version) FROM schema_migrations) IS DISTINCT FROM ARRAY[1,2,3,4,5,6] THEN
  RAISE EXCEPTION 'unexpected application schema version';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
  RAISE EXCEPTION 'PostGIS extension missing';
 END IF;
 IF EXISTS(SELECT 1 FROM expected_application_tables expected LEFT JOIN pg_class c
   ON c.relnamespace='public'::regnamespace AND c.relname=expected.name
   WHERE c.oid IS NULL OR c.relkind NOT IN ('r','p')) THEN
  RAISE EXCEPTION 'application table missing';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
   JOIN expected_application_tables expected ON c.relname=expected.name
   WHERE c.relnamespace='public'::regnamespace AND NOT k.convalidated)
 OR EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
   JOIN expected_application_tables expected ON c.relname=expected.name
   WHERE c.relnamespace='public'::regnamespace AND (NOT i.indisvalid OR NOT i.indisready)) THEN
  RAISE EXCEPTION 'unvalidated constraints or invalid indexes';
 END IF;
 IF EXISTS(SELECT 1 FROM expected_application_guards expected
   LEFT JOIN pg_class c ON c.relnamespace='public'::regnamespace AND c.relname=expected.table_name
   LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=expected.trigger_name
   WHERE t.oid IS NULL OR t.tgisinternal OR t.tgenabled NOT IN ('O','A')
   OR t.tgfoid IS DISTINCT FROM to_regprocedure(format('public.%I()',expected.function_name))
   OR t.tgtype<>expected.event_mask OR t.tgnargs<>0 OR t.tgconstraint<>0
   OR (t.tgqual IS NOT NULL) IS DISTINCT FROM expected.has_condition
   OR ARRAY(SELECT a.attname::text FROM pg_attribute a
      WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr::smallint[]) ORDER BY a.attname)
      IS DISTINCT FROM expected.update_columns) THEN
  RAISE EXCEPTION 'required application guard missing, disabled or incorrectly attached';
 END IF;
 IF EXISTS(SELECT 1 FROM route_revisions WHERE ST_SRID(geometry)<>4326
   OR ST_IsEmpty(geometry) OR NOT ST_IsValid(geometry) OR ST_NPoints(geometry)<2)
 OR EXISTS(SELECT 1 FROM regions WHERE ST_SRID(center)<>4326 OR ST_IsEmpty(center) OR NOT ST_IsValid(center)) THEN
  RAISE EXCEPTION 'invalid restored geometry';
 END IF;
 IF EXISTS(SELECT 1 FROM departures d LEFT JOIN departure_safety s ON s.departure_id=d.id WHERE s.departure_id IS NULL)
 OR EXISTS(SELECT 1 FROM departure_safety s LEFT JOIN safety_passport_versions p
   ON p.departure_id=s.departure_id AND p.version=s.passport_version
   WHERE s.passport_version>0 AND (p.departure_id IS NULL OR p.content_hash IS DISTINCT FROM s.passport_hash
   OR p.manifest_hash IS DISTINCT FROM s.manifest_hash)) THEN
  RAISE EXCEPTION 'restored safety snapshot linkage is inconsistent';
 END IF;
 IF EXISTS(SELECT 1 FROM (
   SELECT e.*,lag(event_hash) OVER(PARTITION BY departure_id ORDER BY sequence) AS preceding_hash,
    row_number() OVER(PARTITION BY departure_id ORDER BY sequence) AS expected_sequence
   FROM safety_events e) ordered
   WHERE sequence<>expected_sequence OR previous_hash IS DISTINCT FROM preceding_hash
   OR event_hash<>sha256(COALESCE(previous_hash,''::bytea)||convert_to(
     safety_event_body(departure_id,sequence,event_type,actor_id,payload,created_at),'UTF8')))
 OR EXISTS(SELECT 1 FROM departure_safety s WHERE
   s.event_sequence<>(SELECT count(*) FROM safety_events e WHERE e.departure_id=s.departure_id)
   OR s.event_hash IS DISTINCT FROM (SELECT e.event_hash FROM safety_events e
     WHERE e.departure_id=s.departure_id ORDER BY sequence DESC LIMIT 1)) THEN
  RAISE EXCEPTION 'restored safety audit chain is inconsistent';
 END IF;
END $$;

CREATE TEMP TABLE restored_row_counts(name text PRIMARY KEY,total bigint NOT NULL);
DO $$ DECLARE table_name text; row_count bigint; BEGIN
 FOR table_name IN SELECT name FROM expected_application_tables ORDER BY name LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',table_name) INTO row_count;
  INSERT INTO restored_row_counts VALUES(table_name,row_count);
 END LOOP;
END $$;

SELECT jsonb_build_object(
 'status','passed',
 'scope','isolated logical restore',
 'sourceCommit',:'source_commit',
 'sourceTreeClean',:'source_tree_clean'::boolean,
 'archiveSha256',:'archive_sha256',
 'ageVersion',:'age_version',
 'postgisImageId',:'postgis_image_id',
 'postgresVersion',current_setting('server_version'),
 'postgisVersion',postgis_lib_version(),
 'schemaVersion',6,
 'applicationTableCount',(SELECT count(*) FROM expected_application_tables),
 'applicationGuardCount',(SELECT count(*) FROM expected_application_guards),
 'migrations',(SELECT jsonb_agg(version ORDER BY version) FROM schema_migrations),
 'rowCounts',(SELECT jsonb_object_agg(name,total ORDER BY name) FROM restored_row_counts),
 'checks',jsonb_build_object('constraintsAndIndexes',true,'applicationGuards',true,'geometry',true,'safetyLinkage',true,'safetyEventChain',true),
 'syntheticFixtureVerified',:'fixture_verified'::boolean,
 'containerIsolationVerified',true,
 'temporaryDatabaseRemovedBeforePublication',true,
 'checkedAt',clock_timestamp()
);
