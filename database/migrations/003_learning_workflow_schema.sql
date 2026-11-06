CREATE TABLE IF NOT EXISTS public.attempts (
  attempt_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_PROGRESS','SUBMITTED','ABANDONED')),
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (student_id, assignment_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS public.submissions (
  submission_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES public.attempts(attempt_id) ON DELETE CASCADE,
  submission_type text CHECK (submission_type IS NULL OR submission_type IN ('text','number','image','file','drawing')),
  submission_text text, submission_file_url text,
  submitted_at timestamptz NOT NULL DEFAULT now(), score numeric CHECK (score IS NULL OR score >= 0)
);
