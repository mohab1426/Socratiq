CREATE TABLE IF NOT EXISTS public.verification_runs (
  verification_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  submission_id text REFERENCES public.submissions(submission_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','ABANDONED')),
  overall_outcome text CHECK (overall_outcome IS NULL OR overall_outcome IN ('PASS','PARTIAL','NEEDS_RETRY','INSUFFICIENT_EVIDENCE')),
  score numeric CHECK (score IS NULL OR score BETWEEN 0 AND 1),
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  feedback text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.verification_questions (
  question_id text PRIMARY KEY,
  verification_id text NOT NULL REFERENCES public.verification_runs(verification_id) ON DELETE CASCADE,
  challenge_id text UNIQUE NOT NULL, display_order integer NOT NULL CHECK (display_order >= 0),
  verification_type text NOT NULL CHECK (verification_type IN ('EXPLAIN','MODIFY','TRANSFER')),
  concept text, question_text text NOT NULL, criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (verification_id, display_order)
);
CREATE TABLE IF NOT EXISTS public.verification_responses (
  response_id text PRIMARY KEY,
  question_id text NOT NULL REFERENCES public.verification_questions(question_id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  response_text text, response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.verification_results (
  result_id text PRIMARY KEY,
  question_id text NOT NULL REFERENCES public.verification_questions(question_id) ON DELETE CASCADE,
  response_id text REFERENCES public.verification_responses(response_id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('PASS','PARTIAL','NEEDS_RETRY','INSUFFICIENT_EVIDENCE')),
  score numeric NOT NULL CHECK (score BETWEEN 0 AND 1),
  confidence numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  feedback text, criteria_evaluations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
