-- This check mutates sequence state only in a disposable restored fixture.
DO $$ BEGIN
 IF current_database()<>'tropa_restore_test' THEN
  RAISE EXCEPTION 'fixture verification requires the isolated restore database';
 END IF;
 IF (SELECT count(*) FROM users)<>3 OR (SELECT count(*) FROM routes)<>1
 OR (SELECT count(*) FROM departures)<>1 OR (SELECT count(*) FROM memberships)<>2
 OR (SELECT count(*) FROM recruitment_members)<>1 OR (SELECT count(*) FROM safety_events)<>1
 OR (SELECT count(*) FROM account_mail_outbox)<>1 OR (SELECT count(*) FROM account_action_tokens)<>1 THEN
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
 IF NOT EXISTS(SELECT 1 FROM account_mail_outbox WHERE id='00000000-0000-4000-8000-000000000050'
   AND purpose='reset_password' AND user_id='00000000-0000-4000-8000-000000000003'
   AND key_id='644c3b61a0e38691c386ea8e92837b1c13fc0582955ee75f774a12bbc22873ae' AND recipient_key=decode('a0fdab14047e6825b6db8bd1c0414513f78eed4ae77b5346629b83a75e8041c1','hex')
   AND payload_cipher=decode('d792b279329daec1b9336cb7cd598aeafc8c2ffa8cb3a785f46df012990a8d8964b6aa6b91dc6b2cfce6f6e2f204adaea3ffdb0dd01d67febbaa8b6a403fa7966a48def3e5b61d16ef64c9386461083e70788e8b0ad6e59731dbc5d3783f71eed4caa60e246af5d6cb976adfcefbc97083aa5862f633ac41b0ccb586a032c0236618775a5ff76abac53ba379320155112d1643242f934b88a3b27b095516861c5ce71f6c86a9396a9e583e0a8c575853b2e8fe81971a46cacfba5178d3a62d6cbd12e4580a617f2a071fe363ab31bfe28da6afe8da9fe74dfbbd8248c74115da43e3757af55ddc4cf9cc8d2d0b487920030d8d3d1ac0fe39b69442922f4b4789c02e8f522fceaf794ee9d7da461e7398dc32b4f103bbb0e2ec66de3d7874f4e11674841a3bb652f9b309a79def700c65fa4c80778a9f046ba547f2fe2bf38c915c75598364a6529da7cb99f5305b60e29ae37ff8febff45b010ba086a696d9dd26ec04dee28999cfc0fdae89a6697a512d0e8e149d7405d7524daa654f8dbd3d66eda1f0d0e5ba1b0573b5ec1db746','hex') AND payload_nonce=decode(repeat('44',12),'hex')
   AND token_hash=decode('0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a','hex') AND state='leased' AND attempts=1
   AND expires_at='2026-01-01T00:30Z' AND lease_id='00000000-0000-4000-8000-000000000051'
   AND lease_until='2026-01-01T00:01Z') THEN
  RAISE EXCEPTION 'encrypted mail payload, token linkage or lease changed during recovery';
 END IF;
 IF nextval('audit_events_id_seq')<>102 OR nextval('outbox_events_id_seq')<>202
 OR nextval('submission_events_id_seq')<>302 OR nextval('safety_events_id_seq')<>402 THEN
  RAISE EXCEPTION 'identity sequence state changed during recovery';
 END IF;
END $$;
