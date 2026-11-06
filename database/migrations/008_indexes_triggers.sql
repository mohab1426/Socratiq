CREATE INDEX IF NOT EXISTS users_university_idx ON public.users(university_id);
CREATE INDEX IF NOT EXISTS courses_university_idx ON public.courses(university_id);
CREATE INDEX IF NOT EXISTS classrooms_course_idx ON public.classrooms(course_id);
CREATE INDEX IF NOT EXISTS enrollments_student_idx ON public.enrollments(student_id);
CREATE INDEX IF NOT EXISTS assignments_course_classroom_idx ON public.assignments(course_id, classroom_id);
CREATE INDEX IF NOT EXISTS learning_events_student_time_idx ON public.learning_events(student_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
