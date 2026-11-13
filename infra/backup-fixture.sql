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
-- Gaps prove restore retained sequence state, not merely MAX(id) from table rows.
SELECT setval('audit_events_id_seq',101,true);
SELECT setval('outbox_events_id_seq',201,true);
SELECT setval('submission_events_id_seq',301,true);
SELECT setval('safety_events_id_seq',401,true);
COMMIT;
