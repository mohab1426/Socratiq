-- 013_rls.sql  -- default-deny Data API + role-aware read policies on EVERY public table.
--
-- Threat model. The frontend uses Supabase only for Auth; ALL data goes through the backend, which connects with a
-- privileged role (bypasses RLS) and enforces authorisation in code (backend/app/access.py). RLS is therefore the
-- second layer that protects the surface the backend does NOT control: PostgREST / Data API with the anon key or a
-- user JWT. It is deliberately read-only: authenticated users never write through the Data API.
--
-- Rules: anon gets nothing. authenticated gets SELECT only, only through policies, only inside their university and
-- only for rows tied to their enrolment / classroom. Students never read evidence or risk signals about themselves
-- (instructor-visible learning indicators). document_chunks (content + embeddings) and retrieval provenance are
-- not readable through the Data API at all.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

-- ---------------------------------------------------------------- helpers (SECURITY DEFINER, pinned search_path)
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT user_id FROM public.users WHERE auth_user_id = auth.uid() $$;
CREATE OR REPLACE FUNCTION app.current_university_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT university_id FROM public.users WHERE auth_user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION app.teaches_course(p_course text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.courses c JOIN public.users u ON u.auth_user_id = auth.uid()
     WHERE c.course_id = p_course AND c.university_id = u.university_id AND u.role = 'PROFESSOR'
       AND (c.instructor_id = u.user_id
            OR EXISTS (SELECT 1 FROM public.classrooms k WHERE k.course_id = c.course_id AND k.professor_id = u.user_id)))
$$;
CREATE OR REPLACE FUNCTION app.teaches_classroom(p_classroom text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.classrooms k JOIN public.courses c ON c.course_id = k.course_id
      JOIN public.users u ON u.auth_user_id = auth.uid()
     WHERE k.classroom_id = p_classroom AND k.university_id = u.university_id AND u.role = 'PROFESSOR'
       AND (k.professor_id = u.user_id OR c.instructor_id = u.user_id))
$$;
CREATE OR REPLACE FUNCTION app.enrolled_in_classroom(p_classroom text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.enrollments e JOIN public.users u ON u.auth_user_id = auth.uid()
                  WHERE e.student_id = u.user_id AND e.classroom_id = p_classroom AND e.status = 'active'
                    AND e.university_id = u.university_id)
$$;
CREATE OR REPLACE FUNCTION app.enrolled_in_course(p_course text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.enrollments e JOIN public.users u ON u.auth_user_id = auth.uid()
                  WHERE e.student_id = u.user_id AND e.course_id = p_course AND e.status = 'active'
                    AND e.university_id = u.university_id)
$$;
CREATE OR REPLACE FUNCTION app.teaches_assignment(p_assignment text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.assignments a WHERE a.assignment_id = p_assignment AND app.teaches_course(a.course_id))
$$;
CREATE OR REPLACE FUNCTION app.assignment_visible_to_student(p_assignment text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.assignments a
                  WHERE a.assignment_id = p_assignment AND a.status = 'PUBLISHED' AND app.enrolled_in_classroom(a.classroom_id))
$$;
CREATE OR REPLACE FUNCTION app.teaches_student(p_student text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.enrollments e WHERE e.student_id = p_student AND app.teaches_classroom(e.classroom_id))
$$;
CREATE OR REPLACE FUNCTION app.taught_by(p_professor text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.enrollments e JOIN public.users u ON u.auth_user_id = auth.uid()
                   JOIN public.classrooms k ON k.classroom_id = e.classroom_id JOIN public.courses c ON c.course_id = k.course_id
                  WHERE e.student_id = u.user_id AND e.status = 'active'
                    AND (k.professor_id = p_professor OR c.instructor_id = p_professor))
$$;
-- own row for the student, or the instructor of that assignment
CREATE OR REPLACE FUNCTION app.can_see_student_work(p_student text, p_assignment text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_student = app.current_user_id() OR app.teaches_assignment(p_assignment)
$$;
CREATE OR REPLACE FUNCTION app.can_see_session(p_session text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.ai_sessions s WHERE s.session_id = p_session AND app.can_see_student_work(s.student_id, s.assignment_id))
$$;
CREATE OR REPLACE FUNCTION app.can_see_verification(p_verification text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.verification_runs v WHERE v.verification_id = p_verification AND app.can_see_student_work(v.student_id, v.assignment_id))
$$;
CREATE OR REPLACE FUNCTION app.can_see_question(p_question text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.verification_questions q WHERE q.question_id = p_question AND app.can_see_verification(q.verification_id))
$$;
CREATE OR REPLACE FUNCTION app.file_visible(p_file text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stored_files f
     WHERE f.file_id = p_file AND (
       app.teaches_course(f.course_id)
       OR (f.purpose = 'SUBMISSION' AND f.uploader_id = app.current_user_id())
       OR (f.purpose = 'MATERIAL' AND f.status IN ('READY','STORED_ONLY') AND app.enrolled_in_classroom(f.classroom_id))
       OR (f.purpose = 'ASSIGNMENT_ATTACHMENT' AND EXISTS (
             SELECT 1 FROM public.assignment_attachments aa
              WHERE aa.file_id = f.file_id AND app.assignment_visible_to_student(aa.assignment_id)))))
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.gen_join_code() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- default deny
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- PostgreSQL ORs permissive policies together, so a single leftover permissive policy (007's *_self_select policies
-- let students read their own evidence and risk rows) silently widens access. This migration is therefore the
-- SINGLE source of truth for public-schema RLS: every existing policy is dropped and the intended set recreated.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- policies (SELECT only)
CREATE OR REPLACE FUNCTION pg_temp.policy(p_table text, p_using text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_table || '_select', p_table);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', p_table || '_select', p_table, p_using);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated', p_table);
END $$;

SELECT pg_temp.policy('universities',  'university_id = app.current_university_id()');
SELECT pg_temp.policy('users',         'user_id = app.current_user_id() OR (university_id = app.current_university_id() AND (app.teaches_student(user_id) OR app.taught_by(user_id)))');
SELECT pg_temp.policy('students',      'student_id = app.current_user_id() OR app.teaches_student(student_id)');
SELECT pg_temp.policy('professors',    'professor_id = app.current_user_id() OR app.taught_by(professor_id)');
SELECT pg_temp.policy('courses',       'app.teaches_course(course_id) OR app.enrolled_in_course(course_id)');
SELECT pg_temp.policy('classrooms',    'app.teaches_classroom(classroom_id) OR app.enrolled_in_classroom(classroom_id)');
SELECT pg_temp.policy('enrollments',   'student_id = app.current_user_id() OR app.teaches_classroom(classroom_id)');
SELECT pg_temp.policy('concepts',      'university_id = app.current_university_id()');
SELECT pg_temp.policy('assignments',   'app.teaches_course(course_id) OR (status = ''PUBLISHED'' AND app.enrolled_in_classroom(classroom_id))');
SELECT pg_temp.policy('assignment_versions',   'app.teaches_assignment(assignment_id)');
SELECT pg_temp.policy('assignment_concepts',   'app.teaches_assignment(assignment_id) OR app.assignment_visible_to_student(assignment_id)');
SELECT pg_temp.policy('assignment_materials',  'app.teaches_assignment(assignment_id) OR app.assignment_visible_to_student(assignment_id)');
SELECT pg_temp.policy('assignment_attachments','app.teaches_assignment(assignment_id) OR app.assignment_visible_to_student(assignment_id)');
SELECT pg_temp.policy('stored_files',  'app.file_visible(file_id)');
SELECT pg_temp.policy('materials',     'app.teaches_classroom(classroom_id) OR (app.enrolled_in_classroom(classroom_id) AND (file_id IS NULL OR app.file_visible(file_id)))');
SELECT pg_temp.policy('documents',     'app.teaches_course(course_id) OR (app.enrolled_in_course(course_id) AND (classroom_id IS NULL OR app.enrolled_in_classroom(classroom_id)))');
SELECT pg_temp.policy('attempts',      'app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('submissions',   'app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('ai_sessions',   'app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('ai_interactions','app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('messages',      'app.can_see_session(session_id)');
SELECT pg_temp.policy('learning_events','app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('verification_runs',      'app.can_see_student_work(student_id, assignment_id)');
SELECT pg_temp.policy('verification_questions', 'app.can_see_verification(verification_id)');
SELECT pg_temp.policy('verification_responses', 'app.can_see_question(question_id)');
SELECT pg_temp.policy('verification_results',   'app.can_see_question(question_id)');
SELECT pg_temp.policy('student_concept_state',  'student_id = app.current_user_id() OR app.teaches_student(student_id)');
-- instructor-only learning indicators (students do not read evidence/risk rows about themselves)
SELECT pg_temp.policy('evidence_candidates', 'assignment_id IS NOT NULL AND app.teaches_assignment(assignment_id)');
SELECT pg_temp.policy('risk_signals',        'assignment_id IS NOT NULL AND app.teaches_assignment(assignment_id)');
-- NOT granted / no policy => unreadable through the Data API:
--   document_chunks (text + embeddings), ai_interaction_sources (retrieval provenance),
--   evidence_sources, verification_question_evidence, document_chunk_assignments, document_chunk_concepts.

-- never expose storage locations / raw metadata to Data API users
REVOKE SELECT ON public.documents    FROM authenticated;
GRANT  SELECT (document_id, university_id, course_id, classroom_id, uploader_id, filename, file_type, upload_date,
               processing_status, total_pages, total_chunks, mime_type, extension, size_bytes, document_kind)
       ON public.documents TO authenticated;
REVOKE SELECT ON public.stored_files FROM authenticated;
GRANT  SELECT (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename, extension,
               mime_type, kind, size_bytes, index_mode, status, processing_note, page_count, created_at, processed_at)
       ON public.stored_files TO authenticated;

COMMIT;
