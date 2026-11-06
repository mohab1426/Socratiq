CREATE TABLE IF NOT EXISTS public.learning_events (
  event_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text REFERENCES public.assignments(assignment_id) ON DELETE SET NULL,
  session_id text REFERENCES public.ai_sessions(session_id) ON DELETE SET NULL,
  attempt_id text REFERENCES public.attempts(attempt_id) ON DELETE SET NULL,
  interaction_id text REFERENCES public.ai_interactions(interaction_id) ON DELETE SET NULL,
  verification_id text REFERENCES public.verification_runs(verification_id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('ATTEMPT','AI_INTERACTION','REVISION','SUBMISSION','VERIFICATION')),
  occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_event_id text
);
CREATE TABLE IF NOT EXISTS public.evidence_candidates (
  evidence_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text REFERENCES public.assignments(assignment_id) ON DELETE SET NULL,
  concept text,
  evidence_type text NOT NULL CHECK (evidence_type IN ('UNDERSTANDING','MISCONCEPTION','REVISION','INDEPENDENCE','EXPLANATION','TRANSFER')),
  strength text NOT NULL CHECK (strength IN ('WEAK','MODERATE','STRONG')),
  observation text NOT NULL,
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  external_evidence_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.evidence_sources (
  evidence_id text NOT NULL REFERENCES public.evidence_candidates(evidence_id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES public.learning_events(event_id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, event_id)
);
CREATE TABLE IF NOT EXISTS public.verification_question_evidence (
  question_id text NOT NULL REFERENCES public.verification_questions(question_id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES public.evidence_candidates(evidence_id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS public.risk_signals (
  risk_signal_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text REFERENCES public.assignments(assignment_id) ON DELETE SET NULL,
  session_id text REFERENCES public.ai_sessions(session_id) ON DELETE SET NULL,
  learning_event_id text REFERENCES public.learning_events(event_id) ON DELETE SET NULL,
  signal text NOT NULL, observation text, severity text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.student_concept_state (
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  concept_id uuid NOT NULL REFERENCES public.concepts(concept_id) ON DELETE CASCADE,
  mastery_estimate numeric CHECK (mastery_estimate IS NULL OR mastery_estimate BETWEEN 0 AND 1),
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  last_evaluated_at timestamptz, state_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (student_id, concept_id)
);
