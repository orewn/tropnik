-- Synthetic recovery data only. Never apply this fixture to an application DB.
DO $$ BEGIN
 IF current_database()<>'tropa_backup_test' THEN
  RAISE EXCEPTION 'backup fixture requires its disposable source database';
 END IF;
END $$;

BEGIN;
INSERT INTO users(id,email,password_hash,display_name,role,guide_status,is_admin) VALUES
 ('00000000-0000-4000-8000-000000000001','operator@backup.invalid','!fixture','Recovery fixture operator','tourist','none',true),
 ('00000000-0000-4000-8000-000000000002','guide@backup.invalid','!fixture','Recovery fixture guide','guide','verified',false),
 ('00000000-0000-4000-8000-000000000003','tourist@backup.invalid','!fixture','Тест восстановления','tourist','none',false);
INSERT INTO guide_qualifications(user_id,activity,max_difficulty,valid_until,evidence_ref,verified_by)
 VALUES('00000000-0000-4000-8000-000000000002','hiking',2,'2035-01-01T00:00:00Z','SYNTHETIC BACKUP FIXTURE ONLY','00000000-0000-4000-8000-000000000001');
INSERT INTO routes(id,slug,region_id,title,description,activity)
 VALUES('00000000-0000-4000-8000-000000000010','recovery-fixture-only','karelia','Recovery fixture','Not a public hiking route','hiking');
INSERT INTO route_regions(route_id,region_id)
 VALUES('00000000-0000-4000-8000-000000000010','karelia');
INSERT INTO route_revisions(id,route_id,revision,geometry,distance_km,ascent_m,duration_min,difficulty,season,
 source_name,source_url,source_license,source_retrieved_at,reviewed_at,reviewed_by,review_evidence)
 VALUES('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010',1,
 ST_GeomFromText('LINESTRING(33 63,33.01 63.01,33.02 63.015)',4326),2,20,60,'easy','fixture only',
 'Synthetic recovery fixture','https://example.invalid/recovery','fixture only','2026-01-01T00:00:00Z',
 '2026-01-01T00:00:00Z','00000000-0000-4000-8000-000000000001','SYNTHETIC BACKUP FIXTURE ONLY');
UPDATE routes SET current_revision_id='00000000-0000-4000-8000-000000000020',status='published'
 WHERE id='00000000-0000-4000-8000-000000000010';
INSERT INTO departures(id,route_id,route_revision_id,guide_id,created_by,starts_at,ends_at,time_zone,min_people,capacity,status,completed_at)
 VALUES('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000010',
 '00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
 '2026-01-02T08:00:00Z','2026-01-02T12:00:00Z','Europe/Moscow',4,5,'completed','2026-01-02T12:00:00Z');
INSERT INTO memberships(departure_id,user_id,role,status) VALUES
 ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000002','guide','completed'),
 ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000003','tourist','completed');
INSERT INTO messages(departure_id,user_id,body,client_id)
 VALUES('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000003','Только синтетическая проверка восстановления','backup-fixture-message-0001');
INSERT INTO recruitment_requests(id,route_id,created_by,body)
 VALUES('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000010',
 '00000000-0000-4000-8000-000000000003','SYNTHETIC BACKUP FIXTURE ONLY');
INSERT INTO recruitment_members(request_id,user_id)
 VALUES('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000003');

-- A real AES-256-GCM test vector for {"public":{},"private":{}}.
-- Fixture-only key is 0x11 repeated 32 times, nonce 0x22 repeated 12 times,
-- AAD is tropnik-safety:00000000-0000-4000-8000-000000000030:1.
-- It is public test data, never an operator key or a real safety passport.
INSERT INTO safety_passport_versions(departure_id,version,payload_cipher,payload_nonce,public_payload,content_hash,manifest_hash,created_by)
 VALUES('00000000-0000-4000-8000-000000000030',1,
 decode('6cd5773ca2a3f63cc705a541648499a776e5ac960fa396302f32ad60b27dd54aef38aabed9bbc6527b27','hex'),
 decode(repeat('22',12),'hex'),'{}',decode('4145512a06bfb1b9de65d3c8bbf8c6a248bb7d013be7a5b12a22ba685a1bcc4a','hex'),
 sha256('recovery-fixture-manifest'::bytea),'00000000-0000-4000-8000-000000000002');
UPDATE departure_safety SET passport_version=1,status='preparing',
 passport_hash=decode('4145512a06bfb1b9de65d3c8bbf8c6a248bb7d013be7a5b12a22ba685a1bcc4a','hex'),
 manifest_hash=sha256('recovery-fixture-manifest'::bytea)
 WHERE departure_id='00000000-0000-4000-8000-000000000030';
SELECT append_safety_event('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000002','passport.created','{"fixture":true}');
INSERT INTO audit_events(actor_id,action,entity_id)
 VALUES('00000000-0000-4000-8000-000000000001','recovery.fixture','00000000-0000-4000-8000-000000000030');
INSERT INTO outbox_events(aggregate_id,event_type,payload)
 VALUES('00000000-0000-4000-8000-000000000030','recovery.fixture','{"fixture":true}');
INSERT INTO submission_events(user_id,kind,channel,fingerprint)
 VALUES('00000000-0000-4000-8000-000000000003','message','recovery-fixture',sha256('recovery-fixture-message'::bytea));
-- Public synthetic AES-GCM mail vector: independent fixture master 0x33 x32,
-- nonce 0x44 x12, purpose reset_password, deadline 2026-01-01T00:30Z.
-- The fixture token is already expired. No transport runs during recovery.
INSERT INTO account_action_tokens(token_hash,user_id,purpose,created_at,expires_at)
 VALUES(decode('0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a','hex'),'00000000-0000-4000-8000-000000000003',
 'reset_password','2026-01-01T00:00Z','2026-01-01T00:30Z');
INSERT INTO account_mail_outbox(id,purpose,user_id,recipient_key,key_id,payload_cipher,payload_nonce,token_hash,
 state,attempts,created_at,expires_at,next_attempt_at,lease_id,lease_until)
 VALUES('00000000-0000-4000-8000-000000000050','reset_password','00000000-0000-4000-8000-000000000003',
 decode('a0fdab14047e6825b6db8bd1c0414513f78eed4ae77b5346629b83a75e8041c1','hex'),'644c3b61a0e38691c386ea8e92837b1c13fc0582955ee75f774a12bbc22873ae',
 decode('d792b279329daec1b9336cb7cd598aeafc8c2ffa8cb3a785f46df012990a8d8964b6aa6b91dc6b2cfce6f6e2f204adaea3ffdb0dd01d67febbaa8b6a403fa7966a48def3e5b61d16ef64c9386461083e70788e8b0ad6e59731dbc5d3783f71eed4caa60e246af5d6cb976adfcefbc97083aa5862f633ac41b0ccb586a032c0236618775a5ff76abac53ba379320155112d1643242f934b88a3b27b095516861c5ce71f6c86a9396a9e583e0a8c575853b2e8fe81971a46cacfba5178d3a62d6cbd12e4580a617f2a071fe363ab31bfe28da6afe8da9fe74dfbbd8248c74115da43e3757af55ddc4cf9cc8d2d0b487920030d8d3d1ac0fe39b69442922f4b4789c02e8f522fceaf794ee9d7da461e7398dc32b4f103bbb0e2ec66de3d7874f4e11674841a3bb652f9b309a79def700c65fa4c80778a9f046ba547f2fe2bf38c915c75598364a6529da7cb99f5305b60e29ae37ff8febff45b010ba086a696d9dd26ec04dee28999cfc0fdae89a6697a512d0e8e149d7405d7524daa654f8dbd3d66eda1f0d0e5ba1b0573b5ec1db746','hex'),decode(repeat('44',12),'hex'),decode('0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a','hex'),
 'leased',1,'2026-01-01T00:00Z','2026-01-01T00:30Z','2026-01-01T00:00Z',
 '00000000-0000-4000-8000-000000000051','2026-01-01T00:01Z');
-- Gaps prove restore retained sequence state, not merely MAX(id) from table rows.
SELECT setval('audit_events_id_seq',101,true);
SELECT setval('outbox_events_id_seq',201,true);
SELECT setval('submission_events_id_seq',301,true);
SELECT setval('safety_events_id_seq',401,true);
COMMIT;
