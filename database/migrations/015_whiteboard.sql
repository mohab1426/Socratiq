-- 015_whiteboard.sql -- the student's "thinking space" for an attempt: typed steps/equations + freehand strokes.
--
-- Stored on the attempt (one board per attempt) instead of a new table: it is part of the student's work on that attempt, shares its
-- ownership/RLS (013 already restricts attempts to the student and the classroom's instructors) and is read together with it.
-- The Coach reads the TYPED steps (no OCR / computer vision); strokes are kept so the teacher can see the drawing as the student left it.
-- Idempotent; existing rows are untouched (NULL = no board yet).

BEGIN;

ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS whiteboard            jsonb;
ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS whiteboard_updated_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attempts_whiteboard_shape_chk') THEN
    ALTER TABLE public.attempts ADD CONSTRAINT attempts_whiteboard_shape_chk CHECK (
      whiteboard IS NULL OR (jsonb_typeof(whiteboard) = 'object' AND pg_column_size(whiteboard) <= 400000));   -- hard cap independent of the API
  END IF;
END $$;

COMMIT;
