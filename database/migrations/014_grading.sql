-- 014_grading.sql -- instructor grades on the existing submission row (single source of truth: public.submissions).
--
-- submissions.score already existed (nullable, >= 0) but nothing wrote it and it had no scale. This adds the scale and the audit
-- fields instead of creating a second grades table, so teacher dashboard, submission review and the student view all read ONE row.
-- Idempotent. Existing scores are preserved: rows that already had a score get a scale (100, or higher if the score exceeds 100)
-- and graded_at = submitted_at; graded_by stays NULL because the original grader is unknown.
-- RLS: submissions already has a read policy (013) that exposes a row only to its student and the instructors of the classroom;
-- grade columns inherit it. Nobody writes through the Data API; the backend writes with instructor authorisation checked in code.

BEGIN;

ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS max_score  numeric;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS feedback   text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS graded_at  timestamptz;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS graded_by  text REFERENCES public.users(user_id) ON DELETE SET NULL;

UPDATE public.submissions
   SET max_score = GREATEST(100, ceil(score)), graded_at = COALESCE(graded_at, submitted_at)
 WHERE score IS NOT NULL AND max_score IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_grade_consistent_chk') THEN
    ALTER TABLE public.submissions ADD CONSTRAINT submissions_grade_consistent_chk CHECK (
      (score IS NULL AND max_score IS NULL AND graded_at IS NULL AND graded_by IS NULL AND feedback IS NULL)
      OR (score IS NOT NULL AND max_score IS NOT NULL AND max_score > 0 AND score <= max_score AND graded_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_feedback_len_chk') THEN
    ALTER TABLE public.submissions ADD CONSTRAINT submissions_feedback_len_chk CHECK (feedback IS NULL OR char_length(feedback) <= 4000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS submissions_graded_idx ON public.submissions (assignment_id) WHERE score IS NOT NULL;

COMMIT;
