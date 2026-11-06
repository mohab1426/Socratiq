CREATE TABLE IF NOT EXISTS public.ai_sessions (
  session_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  attempt_id text REFERENCES public.attempts(attempt_id) ON DELETE SET NULL,
  policy text NOT NULL CHECK (policy IN ('GUIDED','ASSISTED','OPEN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED','ABANDONED')),
  client_session_id text, turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_interactions (
  interaction_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.ai_sessions(session_id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  intervention_type text NOT NULL CHECK (intervention_type IN ('QUESTION','HINT','EXPLANATION','GUIDED_DEBUGGING','FEEDBACK','CLARIFICATION','ENCOURAGEMENT')),
  assistance_level text NOT NULL CHECK (assistance_level IN ('GUIDED','ASSISTED','OPEN')),
  diagnosis text CHECK (diagnosis IS NULL OR diagnosis IN ('MISCONCEPTION','CONCEPTUAL_GAP','PROCEDURAL_ERROR','LOGICAL_ERROR','CODE_ERROR','INCOMPLETE_REASONING','CORRECT_REASONING','UNCERTAIN')),
  diagnosis_confidence numeric CHECK (diagnosis_confidence IS NULL OR diagnosis_confidence BETWEEN 0 AND 1),
  diagnosis_explanation text, diagnosis_evidence text, response text NOT NULL,
  referenced_concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_interaction_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.messages (
  message_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.ai_sessions(session_id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('STUDENT','COACH')),
  content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_interaction_sources (
  interaction_id text NOT NULL REFERENCES public.ai_interactions(interaction_id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES public.documents(document_id) ON DELETE CASCADE,
  chunk_id text NOT NULL REFERENCES public.document_chunks(chunk_id) ON DELETE CASCADE,
  dense_score double precision, fts_score double precision, rrf_score double precision,
  rerank_score double precision, final_score double precision, retrieval_rank integer,
  PRIMARY KEY (interaction_id, chunk_id)
);
