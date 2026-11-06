-- 012_indexes.sql  -- indexes for the access paths the API actually uses. IF NOT EXISTS everywhere.
-- (Not blanket FK indexing: each entry below backs a concrete query, noted on the right.)
CREATE INDEX IF NOT EXISTS enrollments_classroom_status_idx  ON public.enrollments (classroom_id, status);   -- roster, teacher authz
CREATE INDEX IF NOT EXISTS enrollments_student_status_idx    ON public.enrollments (student_id, status);     -- student authz / course list
CREATE INDEX IF NOT EXISTS enrollments_course_idx            ON public.enrollments (course_id);
CREATE INDEX IF NOT EXISTS classrooms_professor_idx          ON public.classrooms (professor_id);            -- teacher authz
CREATE INDEX IF NOT EXISTS courses_instructor_idx            ON public.courses (instructor_id);              -- teacher course list
CREATE INDEX IF NOT EXISTS assignments_classroom_status_idx  ON public.assignments (classroom_id, status);   -- student assignment list
CREATE INDEX IF NOT EXISTS assignments_course_status_due_idx ON public.assignments (course_id, status, due_at);
CREATE INDEX IF NOT EXISTS attempts_assignment_status_idx    ON public.attempts (assignment_id, status);     -- teacher submission table
CREATE INDEX IF NOT EXISTS attempts_student_assignment_idx   ON public.attempts (student_id, assignment_id, started_at DESC);
CREATE INDEX IF NOT EXISTS submissions_assignment_student_idx ON public.submissions (assignment_id, student_id);
CREATE INDEX IF NOT EXISTS ai_sessions_student_assignment_idx ON public.ai_sessions (student_id, assignment_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_interactions_session_idx       ON public.ai_interactions (session_id, created_at);
CREATE INDEX IF NOT EXISTS ai_interactions_student_assignment_idx ON public.ai_interactions (student_id, assignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_session_created_idx      ON public.messages (session_id, created_at);    -- chat history
CREATE INDEX IF NOT EXISTS verification_runs_student_assignment_idx ON public.verification_runs (student_id, assignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_runs_assignment_status_idx  ON public.verification_runs (assignment_id, status);
CREATE INDEX IF NOT EXISTS verification_responses_question_idx ON public.verification_responses (question_id);
CREATE INDEX IF NOT EXISTS verification_results_question_idx   ON public.verification_results (question_id);
CREATE INDEX IF NOT EXISTS learning_events_assignment_time_idx ON public.learning_events (assignment_id, occurred_at DESC); -- activity feed
CREATE INDEX IF NOT EXISTS learning_events_session_idx       ON public.learning_events (session_id);
CREATE INDEX IF NOT EXISTS evidence_candidates_student_assignment_idx ON public.evidence_candidates (student_id, assignment_id);
CREATE INDEX IF NOT EXISTS evidence_candidates_assignment_idx ON public.evidence_candidates (assignment_id);
CREATE INDEX IF NOT EXISTS risk_signals_student_assignment_idx ON public.risk_signals (student_id, assignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS risk_signals_assignment_idx       ON public.risk_signals (assignment_id);
CREATE INDEX IF NOT EXISTS student_concept_state_concept_idx ON public.student_concept_state (concept_id);
CREATE INDEX IF NOT EXISTS materials_classroom_created_idx   ON public.materials (classroom_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_uploader_idx            ON public.documents (uploader_id);
CREATE INDEX IF NOT EXISTS assignment_materials_document_idx ON public.assignment_materials (document_id);
CREATE INDEX IF NOT EXISTS assignment_concepts_concept_idx   ON public.assignment_concepts (concept_id);
CREATE INDEX IF NOT EXISTS assignment_attachments_assignment_idx ON public.assignment_attachments (assignment_id);
CREATE INDEX IF NOT EXISTS ai_interaction_sources_chunk_idx  ON public.ai_interaction_sources (chunk_id);
CREATE INDEX IF NOT EXISTS ai_interaction_sources_document_idx ON public.ai_interaction_sources (document_id);
CREATE INDEX IF NOT EXISTS stored_files_course_purpose_idx   ON public.stored_files (university_id, course_id, purpose, status);
CREATE INDEX IF NOT EXISTS stored_files_uploader_idx         ON public.stored_files (uploader_id);
CREATE INDEX IF NOT EXISTS stored_files_document_idx         ON public.stored_files (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stored_files_queue_idx            ON public.stored_files (updated_at) WHERE status IN ('QUEUED','PROCESSING');  -- worker claim
