CREATE TABLE IF NOT EXISTS public.universities (
  university_id text PRIMARY KEY, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.users (
  user_id text PRIMARY KEY,
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  university_id text NOT NULL REFERENCES public.universities(university_id) ON DELETE CASCADE,
  email text NOT NULL, first_name text, last_name text,
  role text NOT NULL CHECK (role IN ('STUDENT','PROFESSOR','ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.students (
  student_id text PRIMARY KEY REFERENCES public.users(user_id) ON DELETE CASCADE,
  student_code text UNIQUE
);
CREATE TABLE IF NOT EXISTS public.professors (
  professor_id text PRIMARY KEY REFERENCES public.users(user_id) ON DELETE CASCADE,
  professor_code text UNIQUE
);
CREATE TABLE IF NOT EXISTS public.courses (
  course_id text PRIMARY KEY,
  university_id text NOT NULL REFERENCES public.universities(university_id) ON DELETE CASCADE,
  instructor_id text REFERENCES public.professors(professor_id) ON DELETE SET NULL,
  code text NOT NULL, title text NOT NULL, description text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (university_id, code)
);
CREATE TABLE IF NOT EXISTS public.classrooms (
  classroom_id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  professor_id text REFERENCES public.professors(professor_id) ON DELETE SET NULL,
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.enrollments (
  enrollment_id text PRIMARY KEY,
  student_id text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  classroom_id text REFERENCES public.classrooms(classroom_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (student_id, classroom_id)
);
CREATE TABLE IF NOT EXISTS public.materials (
  material_id text PRIMARY KEY,
  classroom_id text NOT NULL REFERENCES public.classrooms(classroom_id) ON DELETE CASCADE,
  document_id text REFERENCES public.documents(document_id) ON DELETE SET NULL,
  title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.concepts (
  concept_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id text NOT NULL REFERENCES public.universities(university_id) ON DELETE CASCADE,
  name text NOT NULL, description text,
  parent_concept_id uuid REFERENCES public.concepts(concept_id) ON DELETE SET NULL,
  UNIQUE (university_id, name)
);
CREATE TABLE IF NOT EXISTS public.assignments (
  assignment_id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  classroom_id text REFERENCES public.classrooms(classroom_id) ON DELETE CASCADE,
  title text NOT NULL, instructions text NOT NULL, subject_area text,
  is_programming boolean NOT NULL DEFAULT false,
  default_policy text NOT NULL DEFAULT 'GUIDED' CHECK (default_policy IN ('GUIDED','ASSISTED','OPEN')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.assignment_concepts (
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  concept_id uuid NOT NULL REFERENCES public.concepts(concept_id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, concept_id)
);
CREATE TABLE IF NOT EXISTS public.assignment_materials (
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES public.documents(document_id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, document_id)
);
CREATE TABLE IF NOT EXISTS public.document_chunk_assignments (
  assignment_id text NOT NULL REFERENCES public.assignments(assignment_id) ON DELETE CASCADE,
  chunk_id text NOT NULL REFERENCES public.document_chunks(chunk_id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS public.document_chunk_concepts (
  chunk_id text NOT NULL REFERENCES public.document_chunks(chunk_id) ON DELETE CASCADE,
  concept_id uuid NOT NULL REFERENCES public.concepts(concept_id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, concept_id)
);
