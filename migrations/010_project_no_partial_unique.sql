-- 010_project_no_partial_unique.sql
--
-- Projects are soft-deleted (projects.deleted_at). The original schema put a
-- plain UNIQUE on project_no, so a soft-deleted project still reserves its
-- number: creating a new project that reuses a deleted project's number fails
-- with a 409 "already exists" even though the UI shows the project as gone.
--
-- Replace the unconditional UNIQUE with a partial unique index scoped to live
-- rows, so a number is only unique among non-deleted projects and can be
-- reused after deletion. Matches the deleted_at-aware indexing already used by
-- idx_projects_status.

-- Drop the auto-named unique constraint from the original CREATE TABLE.
-- (Postgres names it "<table>_<column>_key" unless overridden.)
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_no_key;

-- Enforce uniqueness only among live (non-deleted) projects.
CREATE UNIQUE INDEX IF NOT EXISTS projects_project_no_active_uq
    ON projects (project_no)
    WHERE deleted_at IS NULL;
