-- #19: enforce NN #5 audit-log immutability at the DATABASE level (defense-in-depth beyond the
-- app-side hash chain). Makes rs_audit append-only for the app role: it may INSERT + SELECT but never
-- UPDATE/DELETE, so even a compromised app credential cannot rewrite or erase audit history.
--
-- Run ONCE as the `postgres` superuser after the app has created the tables (PostgresRuntimeStore.migrate
-- runs CREATE TABLE on first boot), and again for any NEW instance/database. The app connects as a
-- non-privileged user and cannot perform this itself (it currently OWNS rs_audit, and an owner keeps
-- privileges regardless of REVOKE — hence the ownership reassignment below).
--
-- Usage via the Cloud SQL Auth proxy (postgres password lives in Secret Manager, never in code):
--   cloud-sql-proxy --port 5433 <PROJECT>:<REGION>:<INSTANCE> &
--   PGPASSWORD="$(gcloud secrets versions access latest --secret=palup-staging-pg-root)" \
--     psql "host=127.0.0.1 port=5433 user=postgres dbname=palup" -f scripts/setup-audit-immutability.sql
--
-- Adjust `palup_app` if the app role differs. Idempotent: safe to re-run.

GRANT palup_app TO postgres;                 -- so postgres may reassign objects owned by the app role
ALTER TABLE rs_audit OWNER TO postgres;      -- app no longer owns rs_audit
REVOKE ALL PRIVILEGES ON rs_audit FROM palup_app;
GRANT SELECT, INSERT ON rs_audit TO palup_app;   -- append + read only; no UPDATE/DELETE

-- Verify (should list exactly INSERT, SELECT):
-- SELECT privilege_type FROM information_schema.role_table_grants
--   WHERE grantee='palup_app' AND table_name='rs_audit' ORDER BY privilege_type;
