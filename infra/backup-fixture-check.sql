-- This check mutates sequence state only in a disposable restored fixture.
DO $$ BEGIN
 IF current_database()<>'tropa_restore_test' THEN
  RAISE EXCEPTION 'fixture verification requires the isolated restore database';
 END IF;
 IF (SELECT count(*) FROM users)<>3 OR (SELECT count(*) FROM routes)<>1
 OR (SELECT count(*) FROM departures)<>1 OR (SELECT count(*) FROM memberships)<>2
 OR (SELECT count(*) FROM recruitment_members)<>1 OR (SELECT count(*) FROM safety_events)<>1 THEN
  RAISE EXCEPTION 'synthetic row counts changed during recovery';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id='00000000-0000-4000-8000-000000000003'
   AND email='tourist@backup.invalid' AND display_name='Тест восстановления' AND password_hash='!fixture')
 OR NOT EXISTS(SELECT 1 FROM messages WHERE client_id='backup-fixture-message-0001'
   AND body='Только синтетическая проверка восстановления') THEN
  RAISE EXCEPTION 'synthetic data changed during recovery';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM route_revisions WHERE id='00000000-0000-4000-8000-000000000020'
   AND ST_AsEWKB(geometry)=ST_AsEWKB(ST_GeomFromText('LINESTRING(33 63,33.01 63.01,33.02 63.015)',4326))) THEN
  RAISE EXCEPTION 'PostGIS geometry changed during recovery';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM safety_passport_versions
   WHERE departure_id='00000000-0000-4000-8000-000000000030' AND version=1
   AND payload_cipher=decode('6cd5773ca2a3f63cc705a541648499a776e5ac960fa396302f32ad60b27dd54aef38aabed9bbc6527b27','hex')
   AND payload_nonce=decode(repeat('22',12),'hex') AND public_payload='{}'::jsonb
   AND content_hash=decode('4145512a06bfb1b9de65d3c8bbf8c6a248bb7d013be7a5b12a22ba685a1bcc4a','hex')
   AND manifest_hash=sha256('recovery-fixture-manifest'::bytea)) THEN
  RAISE EXCEPTION 'safety ciphertext or its metadata changed during recovery';
 END IF;
 IF nextval('audit_events_id_seq')<>102 OR nextval('outbox_events_id_seq')<>202
 OR nextval('submission_events_id_seq')<>302 OR nextval('safety_events_id_seq')<>402 THEN
  RAISE EXCEPTION 'identity sequence state changed during recovery';
 END IF;
END $$;
