-- Shared security floor for native and restore gates; no runtime override.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_setting('server_version_num')::integer NOT BETWEEN 180007 AND 189999 THEN
  RAISE EXCEPTION 'PostgreSQL 18.7 or a later PostgreSQL 18 patch is required';
 END IF;
 IF current_setting('composite_type_mismatch',true) IS DISTINCT FROM 'error' THEN
  RAISE EXCEPTION 'composite type mismatch protection must remain strict';
 END IF;
 IF public.postgis_lib_version() IS DISTINCT FROM '3.7.0'
 OR split_part(public.postgis_scripts_installed(),' ',1) IS DISTINCT FROM '3.7.0' THEN
  RAISE EXCEPTION 'the verified PostGIS library and SQL version are required';
 END IF;
END; $$;
