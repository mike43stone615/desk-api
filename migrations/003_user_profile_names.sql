-- Add profile names collected during account creation.
-- Existing accounts are preserved with blank profile names and can be updated later.

ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
