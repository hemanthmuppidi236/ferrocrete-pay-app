-- 002_add_gc_address.sql
-- Adds gc_address column to projects table.
-- This column is populated by the Excel importer when it extracts GC
-- (General Contractor) info from the 702 sheet during pay-app file import.
-- Without this column, imports fail with:
--   "Could not find the 'gc_address' column of 'projects' in the schema cache"

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS gc_address text;

-- Reload PostgREST's schema cache so the new column is visible via the API.
-- (Supabase auto-reloads on schema changes, but this is a belt-and-suspenders
-- nudge in case the auto-reload is delayed.)
NOTIFY pgrst, 'reload schema';
