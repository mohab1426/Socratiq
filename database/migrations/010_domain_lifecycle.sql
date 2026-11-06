-- 010_domain_lifecycle.sql
-- Adds the lifecycle the application actually needs and enforces it in the database:
--   course status/colour, per-classroom RANDOM join codes (course codes like "PHYS 111" are guessable),
--   assignment due date + DRAFT/PUBLISHED/ARCHIVED lifecycle with enforced transitions,
--   assignment version snapshots (evidence stays interpretable after an instructor edits a prompt),
--   attempt / AI-session / verification uniqueness ("one open thing at a time") and one submission per attempt.
-- Idempotent. Existing rows are preserved; duplicate open rows are CLOSED (never deleted).

BEGIN;

-- ------------------------------------------------------------------ courses
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'plum';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='courses_status_check') THEN
    ALTER TABLE public.courses ADD CONSTRAINT courses_status_check CHECK (status IN ('ACTIVE','ARCHIVED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='courses_color_check') THEN
    ALTER TABLE public.courses ADD CONSTRAINT courses_color_check CHECK (color ~ '^[a-z][a-z0-9-]{1,23}$');
  END IF;
END $$;
DROP TRIGGER IF EXISTS courses_set_updated_at ON public.courses;
CREATE TRIGGER courses_set_updated_at BEFORE UPDATE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------------ classrooms: random join codes
CREATE OR REPLACE FUNCTION public.gen_join_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = public, extensions AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O/1/I/L
  b bytea := gen_random_bytes(8);
  code text := '';
  i int;
BEGIN
  FOR i IN 0..7 LOOP
    code := code || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  END LOOP;
  RETURN substr(code, 1, 4) || '-' || substr(code, 5, 4);
END $$;

ALTER TABLE public.classrooms ADD COLUMN IF NOT EXISTS join_code text;
ALTER TABLE public.classrooms ADD COLUMN IF NOT EXISTS join_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.classrooms ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.classrooms SET join_code = public.gen_join_code() WHERE join_code IS NULL;
ALTER TABLE public.classrooms ALTER COLUMN join_code SET DEFAULT public.gen_join_code();
ALTER TABLE public.classrooms ALTER COLUMN join_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS classrooms_join_code_uidx ON public.classrooms (join_code);
DROP TRIGGER IF EXISTS classrooms_set_updated_at ON public.classrooms;
CREATE TRIGGER classrooms_set_updated_at BEFORE UPDATE ON public.classrooms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------------ assignments
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS due_at timestamptz;
-- Existing rows were visible to students, so they default to PUBLISHED; the API creates new ones as DRAFT.
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS created_by text;
UPDATE public.assignments SET published_at = created_at WHERE status = 'PUBLISHED' AND published_at IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assignments_status_check') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_status_check CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assignments_version_check') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_version_check CHECK (version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assignments_created_by_university_fk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_created_by_university_fk
      FOREIGN KEY (created_by, university_id) REFERENCES public.users (user_id, university_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.assignment_versions (
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  title         text NOT NULL,
  instructions  text NOT NULL,
  due_at        timestamptz,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, version)
);

CREATE OR REPLACE FUNCTION public.assignments_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    NEW.updated_at := now();
    IF NEW.status = 'PUBLISHED' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'DRAFT'     AND NEW.status IN ('PUBLISHED','ARCHIVED'))
      OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('ARCHIVED','DRAFT'))
      OR (OLD.status = 'ARCHIVED'  AND NEW.status = 'PUBLISHED')
    ) THEN
      RAISE EXCEPTION 'invalid assignment status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    -- un-publishing after students started would orphan their evidence
    IF OLD.status = 'PUBLISHED' AND NEW.status = 'DRAFT'
       AND EXISTS (SELECT 1 FROM public.attempts WHERE assignment_id = OLD.assignment_id) THEN
      RAISE EXCEPTION 'cannot return a started assignment to DRAFT; archive it instead'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'PUBLISHED' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.instructions IS DISTINCT FROM OLD.instructions
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.subject_area IS DISTINCT FROM OLD.subject_area
     OR NEW.default_policy IS DISTINCT FROM OLD.default_policy
     OR NEW.is_programming IS DISTINCT FROM OLD.is_programming THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignments_lifecycle_trg ON public.assignments;
CREATE TRIGGER assignments_lifecycle_trg BEFORE INSERT OR UPDATE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.assignments_lifecycle();

CREATE OR REPLACE FUNCTION public.assignments_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.assignment_versions (assignment_id, version, title, instructions, due_at, status)
  VALUES (NEW.assignment_id, NEW.version, NEW.title, NEW.instructions, NEW.due_at, NEW.status)
  ON CONFLICT (assignment_id, version) DO UPDATE
    SET title = EXCLUDED.title, instructions = EXCLUDED.instructions,
        due_at = EXCLUDED.due_at, status = EXCLUDED.status;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assignments_snapshot_trg ON public.assignments;
CREATE TRIGGER assignments_snapshot_trg AFTER INSERT OR UPDATE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.assignments_snapshot();
INSERT INTO public.assignment_versions (assignment_id, version, title, instructions, due_at, status)
  SELECT assignment_id, version, title, instructions, due_at, status FROM public.assignments
  ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ attempts
ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS assignment_version integer;
-- the student's current work-in-progress text (what the Coach is asked to look at)
ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS draft_text text CHECK (draft_text IS NULL OR char_length(draft_text) <= 100000);
ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.attempts t SET assignment_version = a.version FROM public.assignments a
  WHERE a.assignment_id = t.assignment_id AND t.assignment_version IS NULL;

-- close (never delete) older duplicate open attempts before the uniqueness rule
UPDATE public.attempts a SET status = 'ABANDONED', ended_at = COALESCE(a.ended_at, now())
 WHERE a.status IN ('DRAFT','IN_PROGRESS')
   AND EXISTS (SELECT 1 FROM public.attempts b
                WHERE b.student_id = a.student_id AND b.assignment_id = a.assignment_id
                  AND b.status IN ('DRAFT','IN_PROGRESS')
                  AND (b.started_at, b.attempt_id) > (a.started_at, a.attempt_id));
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_open_per_student_assignment
  ON public.attempts (student_id, assignment_id) WHERE status IN ('DRAFT','IN_PROGRESS');

CREATE OR REPLACE FUNCTION public.attempts_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assignment_version IS NULL THEN
      SELECT version INTO NEW.assignment_version FROM public.assignments WHERE assignment_id = NEW.assignment_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'DRAFT'       AND NEW.status IN ('IN_PROGRESS','SUBMITTED','ABANDONED'))
      OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('SUBMITTED','ABANDONED'))
    ) THEN
      RAISE EXCEPTION 'invalid attempt status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('SUBMITTED','ABANDONED') AND NEW.ended_at IS NULL THEN NEW.ended_at := now(); END IF;
  END IF;
  NEW.assignment_version := OLD.assignment_version;     -- immutable snapshot reference
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS attempts_lifecycle_trg ON public.attempts;
CREATE TRIGGER attempts_lifecycle_trg BEFORE INSERT OR UPDATE ON public.attempts
  FOR EACH ROW EXECUTE FUNCTION public.attempts_lifecycle();

-- ------------------------------------------------------------------ chat messages know which interaction produced them
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS interaction_id text REFERENCES public.ai_interactions(interaction_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_interaction_idx ON public.messages (interaction_id) WHERE interaction_id IS NOT NULL;

-- ------------------------------------------------------------------ submissions: one per attempt
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.submissions GROUP BY attempt_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '010 aborted: several submissions share one attempt; resolve manually before enforcing uniqueness';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_attempt_uidx ON public.submissions (attempt_id);

-- ------------------------------------------------------------------ AI sessions / verification: one open at a time
UPDATE public.ai_sessions a SET status = 'ENDED', ended_at = COALESCE(a.ended_at, now())
 WHERE a.status = 'ACTIVE' AND a.attempt_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.ai_sessions b
                WHERE b.attempt_id = a.attempt_id AND b.status = 'ACTIVE'
                  AND (b.started_at, b.session_id) > (a.started_at, a.session_id));
CREATE UNIQUE INDEX IF NOT EXISTS ai_sessions_one_active_per_attempt
  ON public.ai_sessions (attempt_id) WHERE status = 'ACTIVE' AND attempt_id IS NOT NULL;

UPDATE public.verification_runs a SET status = 'ABANDONED'
 WHERE a.status = 'IN_PROGRESS'
   AND EXISTS (SELECT 1 FROM public.verification_runs b
                WHERE b.attempt_id = a.attempt_id AND b.status = 'IN_PROGRESS'
                  AND (b.created_at, b.verification_id) > (a.created_at, a.verification_id));
CREATE UNIQUE INDEX IF NOT EXISTS verification_runs_one_open_per_attempt
  ON public.verification_runs (attempt_id) WHERE status = 'IN_PROGRESS';
CREATE UNIQUE INDEX IF NOT EXISTS verification_results_response_uidx
  ON public.verification_results (response_id) WHERE response_id IS NOT NULL;

-- ------------------------------------------------------------------ concepts: case-insensitive uniqueness
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.concepts GROUP BY university_id, normalized_name HAVING count(*) > 1) THEN
    RAISE EXCEPTION '010 aborted: concepts differing only by case/whitespace exist; merge them first';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS concepts_university_normalized_uidx
  ON public.concepts (university_id, normalized_name);

COMMIT;
