-- 009_tenant_integrity.sql
-- Makes multi-tenant integrity a DATABASE guarantee instead of an application convention.
--
-- Idempotent by design: it upgrades (a) a fresh database built from 000-008 and
-- (b) the existing Supabase project, whose schema already has many of these columns and
-- composite foreign keys under the names used below. Anything that already exists is skipped.
--
-- Data safety: nothing is dropped. Missing tenant columns are BACKFILLED from parent rows.
-- If existing rows disagree with their parent's university the migration ABORTS with a
-- clear message instead of silently picking a side.
-- NOTE: with MATCH SIMPLE composite foreign keys a NULL column disables the check, which is
-- why every tenant column below is made NOT NULL before its composite FK is added.

BEGIN;

-- 008 defines this on fresh databases; the live project may not have it, and 010/011 rely on it.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------------------------------------------------------------- helpers (session-local)
CREATE OR REPLACE FUNCTION pg_temp.colnames(p_rel oid, p_keys int2[]) RETURNS text[]
LANGUAGE sql AS $$
  SELECT array_agg(a.attname::text ORDER BY k.ord)
  FROM unnest(p_keys) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = p_rel AND a.attnum = k.attnum
$$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_unique(p_table regclass, p_name text, p_cols text[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = p_table AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
      AND (SELECT array_agg(c ORDER BY c) FROM unnest(pg_temp.colnames(i.indrelid, i.indkey::int2[])) c)
        = (SELECT array_agg(c ORDER BY c) FROM unnest(p_cols) c)
  ) THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (%s)', p_table, p_name, array_to_string(p_cols, ', '));
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ensure_fk(
  p_table regclass, p_name text, p_cols text[], p_ref regclass, p_refcols text[],
  p_ondelete text DEFAULT 'NO ACTION')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = p_table AND conname = p_name) THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = p_table AND c.contype = 'f' AND c.confrelid = p_ref
      AND pg_temp.colnames(c.conrelid, c.conkey) = p_cols
      AND pg_temp.colnames(c.confrelid, c.confkey) = p_refcols
  ) THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %s (%s) ON DELETE %s NOT VALID',
                 p_table, p_name, array_to_string(p_cols, ', '), p_ref, array_to_string(p_refcols, ', '), p_ondelete);
  EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', p_table, p_name);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_zero(p_sql text, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE p_sql INTO n;
  IF n > 0 THEN RAISE EXCEPTION '009 aborted: % (% rows). Fix the data, then re-run.', p_msg, n; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.set_not_null(p_table regclass, p_col text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.assert_zero(format('SELECT count(*) FROM %s WHERE %I IS NULL', p_table, p_col),
                              format('%s.%s still has NULLs after backfill', p_table, p_col));
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET NOT NULL', p_table, p_col);
END $$;

-- ---------------------------------------------------------------- A. missing columns
ALTER TABLE public.students              ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.professors            ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.classrooms            ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.enrollments           ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.assignments           ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.attempts              ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.submissions           ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.submissions           ADD COLUMN IF NOT EXISTS student_id text;
ALTER TABLE public.submissions           ADD COLUMN IF NOT EXISTS assignment_id text;
ALTER TABLE public.ai_sessions           ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.ai_interactions       ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.verification_runs     ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.verification_runs     ADD COLUMN IF NOT EXISTS attempt_id text;
ALTER TABLE public.learning_events       ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.evidence_candidates   ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.risk_signals          ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.student_concept_state ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.assignment_concepts   ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.assignment_materials  ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.assignment_materials  ADD COLUMN IF NOT EXISTS course_id text;
ALTER TABLE public.materials             ADD COLUMN IF NOT EXISTS university_id text;
ALTER TABLE public.materials             ADD COLUMN IF NOT EXISTS course_id text;
ALTER TABLE public.concepts              ADD COLUMN IF NOT EXISTS normalized_name text
  GENERATED ALWAYS AS (lower(btrim(name))) STORED;

-- ---------------------------------------------------------------- B. backfill from parents
UPDATE public.students s   SET university_id = u.university_id FROM public.users u
  WHERE u.user_id = s.student_id AND s.university_id IS NULL;
UPDATE public.professors p SET university_id = u.university_id FROM public.users u
  WHERE u.user_id = p.professor_id AND p.university_id IS NULL;
UPDATE public.classrooms c SET university_id = co.university_id FROM public.courses co
  WHERE co.course_id = c.course_id AND c.university_id IS NULL;
UPDATE public.enrollments e SET university_id = co.university_id FROM public.courses co
  WHERE co.course_id = e.course_id AND e.university_id IS NULL;
UPDATE public.assignments a SET university_id = co.university_id FROM public.courses co
  WHERE co.course_id = a.course_id AND a.university_id IS NULL;
UPDATE public.attempts t SET university_id = a.university_id FROM public.assignments a
  WHERE a.assignment_id = t.assignment_id AND t.university_id IS NULL;
UPDATE public.submissions s SET student_id = t.student_id, assignment_id = t.assignment_id,
       university_id = t.university_id
  FROM public.attempts t WHERE t.attempt_id = s.attempt_id
   AND (s.student_id IS NULL OR s.assignment_id IS NULL OR s.university_id IS NULL);
UPDATE public.ai_sessions x SET university_id = a.university_id FROM public.assignments a
  WHERE a.assignment_id = x.assignment_id AND x.university_id IS NULL;
UPDATE public.ai_interactions i SET university_id = x.university_id FROM public.ai_sessions x
  WHERE x.session_id = i.session_id AND i.university_id IS NULL;
UPDATE public.verification_runs v SET attempt_id = s.attempt_id FROM public.submissions s
  WHERE s.submission_id = v.submission_id AND v.attempt_id IS NULL;
UPDATE public.verification_runs v SET attempt_id = (
    SELECT t.attempt_id FROM public.attempts t
     WHERE t.student_id = v.student_id AND t.assignment_id = v.assignment_id
     ORDER BY t.started_at DESC LIMIT 1)
  WHERE v.attempt_id IS NULL;
UPDATE public.verification_runs v SET university_id = a.university_id FROM public.assignments a
  WHERE a.assignment_id = v.assignment_id AND v.university_id IS NULL;
UPDATE public.learning_events l SET university_id = s.university_id FROM public.students s
  WHERE s.student_id = l.student_id AND l.university_id IS NULL;
UPDATE public.evidence_candidates l SET university_id = s.university_id FROM public.students s
  WHERE s.student_id = l.student_id AND l.university_id IS NULL;
UPDATE public.risk_signals l SET university_id = s.university_id FROM public.students s
  WHERE s.student_id = l.student_id AND l.university_id IS NULL;
UPDATE public.student_concept_state l SET university_id = s.university_id FROM public.students s
  WHERE s.student_id = l.student_id AND l.university_id IS NULL;
UPDATE public.assignment_concepts ac SET university_id = a.university_id FROM public.assignments a
  WHERE a.assignment_id = ac.assignment_id AND ac.university_id IS NULL;
UPDATE public.assignment_materials am SET university_id = a.university_id, course_id = a.course_id
  FROM public.assignments a WHERE a.assignment_id = am.assignment_id
   AND (am.university_id IS NULL OR am.course_id IS NULL);
UPDATE public.materials m SET university_id = c.university_id, course_id = c.course_id
  FROM public.classrooms c WHERE c.classroom_id = m.classroom_id
   AND (m.university_id IS NULL OR m.course_id IS NULL);

-- ---------------------------------------------------------------- C. abort on cross-tenant drift
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.students s JOIN public.users u ON u.user_id=s.student_id WHERE s.university_id<>u.university_id$q$, 'students.university_id disagrees with users');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.professors s JOIN public.users u ON u.user_id=s.professor_id WHERE s.university_id<>u.university_id$q$, 'professors.university_id disagrees with users');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.classrooms c JOIN public.courses co ON co.course_id=c.course_id WHERE c.university_id<>co.university_id$q$, 'classrooms.university_id disagrees with courses');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.enrollments e JOIN public.courses co ON co.course_id=e.course_id WHERE e.university_id<>co.university_id$q$, 'enrollments.university_id disagrees with courses');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.enrollments e JOIN public.classrooms c ON c.classroom_id=e.classroom_id WHERE e.course_id<>c.course_id$q$, 'enrollments.course_id disagrees with its classroom');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.assignments a JOIN public.courses co ON co.course_id=a.course_id WHERE a.university_id<>co.university_id$q$, 'assignments.university_id disagrees with courses');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.assignments a JOIN public.classrooms c ON c.classroom_id=a.classroom_id WHERE a.course_id<>c.course_id$q$, 'assignments.course_id disagrees with its classroom');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.attempts t JOIN public.assignments a ON a.assignment_id=t.assignment_id WHERE t.university_id<>a.university_id$q$, 'attempts.university_id disagrees with assignments');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.attempts t JOIN public.students s ON s.student_id=t.student_id WHERE t.university_id<>s.university_id$q$, 'attempts.university_id disagrees with students');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.ai_sessions x JOIN public.assignments a ON a.assignment_id=x.assignment_id WHERE x.university_id<>a.university_id$q$, 'ai_sessions.university_id disagrees with assignments');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.ai_sessions x JOIN public.attempts t ON t.attempt_id=x.attempt_id WHERE x.student_id<>t.student_id OR x.assignment_id<>t.assignment_id$q$, 'ai_sessions disagrees with its attempt');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.ai_interactions i JOIN public.ai_sessions x ON x.session_id=i.session_id WHERE i.university_id<>x.university_id OR i.student_id<>x.student_id OR i.assignment_id<>x.assignment_id$q$, 'ai_interactions disagrees with its session');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.verification_runs v JOIN public.attempts t ON t.attempt_id=v.attempt_id WHERE v.student_id<>t.student_id OR v.assignment_id<>t.assignment_id$q$, 'verification_runs disagrees with its attempt');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.assignment_materials am JOIN public.documents d ON d.document_id=am.document_id WHERE d.course_id<>am.course_id OR d.university_id<>am.university_id$q$, 'assignment_materials links a document from another course/university');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.assignment_concepts ac JOIN public.concepts c ON c.concept_id=ac.concept_id WHERE c.university_id<>ac.university_id$q$, 'assignment_concepts links a concept from another university');
SELECT pg_temp.assert_zero($q$SELECT count(*) FROM public.materials m JOIN public.documents d ON d.document_id=m.document_id WHERE d.course_id<>m.course_id OR d.university_id<>m.university_id$q$, 'materials points at a document from another course/university');

-- ---------------------------------------------------------------- D. NOT NULL
SELECT pg_temp.set_not_null('public.students','university_id');
SELECT pg_temp.set_not_null('public.professors','university_id');
SELECT pg_temp.set_not_null('public.classrooms','university_id');
SELECT pg_temp.set_not_null('public.enrollments','university_id');
SELECT pg_temp.set_not_null('public.assignments','university_id');
SELECT pg_temp.set_not_null('public.attempts','university_id');
SELECT pg_temp.set_not_null('public.submissions','university_id');
SELECT pg_temp.set_not_null('public.submissions','student_id');
SELECT pg_temp.set_not_null('public.submissions','assignment_id');
SELECT pg_temp.set_not_null('public.ai_sessions','university_id');
SELECT pg_temp.set_not_null('public.ai_interactions','university_id');
SELECT pg_temp.set_not_null('public.verification_runs','university_id');
SELECT pg_temp.set_not_null('public.verification_runs','attempt_id');
SELECT pg_temp.set_not_null('public.learning_events','university_id');
SELECT pg_temp.set_not_null('public.evidence_candidates','university_id');
SELECT pg_temp.set_not_null('public.risk_signals','university_id');
SELECT pg_temp.set_not_null('public.student_concept_state','university_id');
SELECT pg_temp.set_not_null('public.assignment_concepts','university_id');
SELECT pg_temp.set_not_null('public.assignment_materials','university_id');
SELECT pg_temp.set_not_null('public.assignment_materials','course_id');
SELECT pg_temp.set_not_null('public.materials','university_id');
SELECT pg_temp.set_not_null('public.materials','course_id');
ALTER TABLE public.documents ALTER COLUMN storage_path SET NOT NULL;   -- RAG always stores the file first

-- risk severity vocabulary (live schema already has this CHECK)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.risk_signals'::regclass AND contype='c'
                 AND pg_get_constraintdef(oid) ILIKE '%severity%') THEN
    UPDATE public.risk_signals SET severity = upper(severity) WHERE severity IS NOT NULL;
    ALTER TABLE public.risk_signals ADD CONSTRAINT risk_signals_severity_check
      CHECK (severity IS NULL OR severity IN ('LOW','MEDIUM','HIGH')) NOT VALID;
    ALTER TABLE public.risk_signals VALIDATE CONSTRAINT risk_signals_severity_check;
  END IF;
END $$;

-- ---------------------------------------------------------------- E. unique targets for composite FKs
SELECT pg_temp.ensure_unique('public.users',        'users_user_university_uk',        ARRAY['user_id','university_id']);
SELECT pg_temp.ensure_unique('public.students',     'students_student_university_uk',  ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_unique('public.professors',   'professors_professor_university_uk', ARRAY['professor_id','university_id']);
SELECT pg_temp.ensure_unique('public.courses',      'courses_course_university_uk',    ARRAY['course_id','university_id']);
SELECT pg_temp.ensure_unique('public.classrooms',   'classrooms_classroom_course_university_uk', ARRAY['classroom_id','course_id','university_id']);
SELECT pg_temp.ensure_unique('public.assignments',  'assignments_assignment_university_uk', ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_unique('public.assignments',  'assignments_assignment_course_university_uk', ARRAY['assignment_id','course_id','university_id']);
SELECT pg_temp.ensure_unique('public.attempts',     'attempts_integrity_uk',           ARRAY['attempt_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_unique('public.submissions',  'submissions_integrity_uk',        ARRAY['submission_id','university_id','student_id','assignment_id']);
SELECT pg_temp.ensure_unique('public.ai_sessions',  'ai_sessions_integrity_uk',        ARRAY['session_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_unique('public.ai_interactions','ai_interactions_integrity_uk',  ARRAY['interaction_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_unique('public.verification_runs','verification_runs_integrity_uk', ARRAY['verification_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_unique('public.documents',    'documents_document_university_course_uk', ARRAY['document_id','university_id','course_id']);
SELECT pg_temp.ensure_unique('public.concepts',     'concepts_concept_university_uk',  ARRAY['concept_id','university_id']);

-- ---------------------------------------------------------------- F. composite tenant foreign keys
-- names below match the live Supabase schema where it already has them.
SELECT pg_temp.ensure_fk('public.students','students_user_university_fk',ARRAY['student_id','university_id'],'public.users',ARRAY['user_id','university_id']);
SELECT pg_temp.ensure_fk('public.professors','professors_user_university_fk',ARRAY['professor_id','university_id'],'public.users',ARRAY['user_id','university_id']);
SELECT pg_temp.ensure_fk('public.courses','courses_instructor_university_fk',ARRAY['instructor_id','university_id'],'public.professors',ARRAY['professor_id','university_id']);
SELECT pg_temp.ensure_fk('public.classrooms','classrooms_course_university_fk',ARRAY['course_id','university_id'],'public.courses',ARRAY['course_id','university_id']);
SELECT pg_temp.ensure_fk('public.classrooms','classrooms_professor_university_fk',ARRAY['professor_id','university_id'],'public.professors',ARRAY['professor_id','university_id']);
SELECT pg_temp.ensure_fk('public.enrollments','enrollments_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.enrollments','enrollments_course_university_fk',ARRAY['course_id','university_id'],'public.courses',ARRAY['course_id','university_id']);
SELECT pg_temp.ensure_fk('public.enrollments','enrollments_classroom_course_university_fk',ARRAY['classroom_id','course_id','university_id'],'public.classrooms',ARRAY['classroom_id','course_id','university_id']);
SELECT pg_temp.ensure_fk('public.concepts','concepts_parent_university_fk',ARRAY['parent_concept_id','university_id'],'public.concepts',ARRAY['concept_id','university_id']);
SELECT pg_temp.ensure_fk('public.documents','documents_course_university_fk',ARRAY['course_id','university_id'],'public.courses',ARRAY['course_id','university_id']);
SELECT pg_temp.ensure_fk('public.documents','documents_classroom_course_university_fk',ARRAY['classroom_id','course_id','university_id'],'public.classrooms',ARRAY['classroom_id','course_id','university_id']);
SELECT pg_temp.ensure_fk('public.documents','documents_uploader_university_fk',ARRAY['uploader_id','university_id'],'public.users',ARRAY['user_id','university_id']);
SELECT pg_temp.ensure_fk('public.document_chunks','document_chunks_document_integrity_fk',ARRAY['document_id','university_id','course_id'],'public.documents',ARRAY['document_id','university_id','course_id']);
SELECT pg_temp.ensure_fk('public.document_chunks','document_chunks_classroom_integrity_fk',ARRAY['classroom_id','course_id','university_id'],'public.classrooms',ARRAY['classroom_id','course_id','university_id']);
-- NEW: assignments were the one core table with NO tenant FK to their course/classroom in the live schema
SELECT pg_temp.ensure_fk('public.assignments','assignments_course_university_fk',ARRAY['course_id','university_id'],'public.courses',ARRAY['course_id','university_id']);
SELECT pg_temp.ensure_fk('public.assignments','assignments_classroom_course_university_fk',ARRAY['classroom_id','course_id','university_id'],'public.classrooms',ARRAY['classroom_id','course_id','university_id']);
SELECT pg_temp.ensure_fk('public.attempts','attempts_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.attempts','attempts_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.submissions','submissions_attempt_integrity_fk',ARRAY['attempt_id','student_id','assignment_id','university_id'],'public.attempts',ARRAY['attempt_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.ai_sessions','ai_sessions_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.ai_sessions','ai_sessions_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.ai_sessions','ai_sessions_attempt_integrity_fk',ARRAY['attempt_id','student_id','assignment_id','university_id'],'public.attempts',ARRAY['attempt_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.ai_interactions','ai_interactions_session_integrity_fk',ARRAY['session_id','student_id','assignment_id','university_id'],'public.ai_sessions',ARRAY['session_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.verification_runs','verification_runs_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.verification_runs','verification_runs_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.verification_runs','verification_runs_submission_integrity_fk',ARRAY['submission_id','university_id','student_id','assignment_id'],'public.submissions',ARRAY['submission_id','university_id','student_id','assignment_id']);
-- NEW: verification run must belong to the same student/assignment/tenant as its attempt
SELECT pg_temp.ensure_fk('public.verification_runs','verification_runs_attempt_integrity_fk',ARRAY['attempt_id','student_id','assignment_id','university_id'],'public.attempts',ARRAY['attempt_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_session_integrity_fk',ARRAY['session_id','student_id','assignment_id','university_id'],'public.ai_sessions',ARRAY['session_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_attempt_integrity_fk',ARRAY['attempt_id','student_id','assignment_id','university_id'],'public.attempts',ARRAY['attempt_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_interaction_integrity_fk',ARRAY['interaction_id','student_id','assignment_id','university_id'],'public.ai_interactions',ARRAY['interaction_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.learning_events','learning_events_verification_integrity_fk',ARRAY['verification_id','student_id','assignment_id','university_id'],'public.verification_runs',ARRAY['verification_id','student_id','assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.evidence_candidates','evidence_candidates_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.evidence_candidates','evidence_candidates_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.risk_signals','risk_signals_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.risk_signals','risk_signals_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id']);
SELECT pg_temp.ensure_fk('public.student_concept_state','student_concept_state_student_university_fk',ARRAY['student_id','university_id'],'public.students',ARRAY['student_id','university_id']);
SELECT pg_temp.ensure_fk('public.student_concept_state','student_concept_state_concept_university_fk',ARRAY['concept_id','university_id'],'public.concepts',ARRAY['concept_id','university_id']);
-- NEW: link tables could previously join rows across universities / courses
SELECT pg_temp.ensure_fk('public.assignment_concepts','assignment_concepts_assignment_university_fk',ARRAY['assignment_id','university_id'],'public.assignments',ARRAY['assignment_id','university_id'],'CASCADE');
SELECT pg_temp.ensure_fk('public.assignment_concepts','assignment_concepts_concept_university_fk',ARRAY['concept_id','university_id'],'public.concepts',ARRAY['concept_id','university_id']);
SELECT pg_temp.ensure_fk('public.assignment_materials','assignment_materials_assignment_course_fk',ARRAY['assignment_id','course_id','university_id'],'public.assignments',ARRAY['assignment_id','course_id','university_id'],'CASCADE');
SELECT pg_temp.ensure_fk('public.assignment_materials','assignment_materials_document_course_fk',ARRAY['document_id','university_id','course_id'],'public.documents',ARRAY['document_id','university_id','course_id']);
SELECT pg_temp.ensure_fk('public.materials','materials_classroom_course_university_fk',ARRAY['classroom_id','course_id','university_id'],'public.classrooms',ARRAY['classroom_id','course_id','university_id']);
SELECT pg_temp.ensure_fk('public.materials','materials_document_course_university_fk',ARRAY['document_id','university_id','course_id'],'public.documents',ARRAY['document_id','university_id','course_id']);

COMMIT;
