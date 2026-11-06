-- 011_file_pipeline.sql
-- Unified, tenant-safe record for EVERY uploaded file (course material, assignment attachment,
-- student submission) so validation results, processing state and errors live in one place.
--
--   upload -> validate -> store -> stored_files row -> (extract -> normalise -> chunk -> embed -> index)
--
-- stored_files is the "document record" of the ingestion flow. The RAG `documents` table stays the AI's
-- own contract (untouched columns); we only ADD nullable metadata columns to it.
--
-- index_mode:  RAG           text is extracted and indexed into the knowledge base (retrieval)
--              EXTRACT_ONLY  text is extracted for immediate use (submission text / assignment prompt) but
--                            is NEVER indexed (student work must not enter shared retrieval)
--              STORAGE_ONLY  stored and served to authorised users only; no extraction is attempted

BEGIN;

CREATE TABLE IF NOT EXISTS public.stored_files (
  file_id            text PRIMARY KEY,
  university_id      text NOT NULL,
  course_id          text NOT NULL,
  classroom_id       text,
  uploader_id        text NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('MATERIAL','ASSIGNMENT_ATTACHMENT','SUBMISSION')),
  original_filename  text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 255),
  extension          text NOT NULL CHECK (extension ~ '^[a-z0-9]{1,10}$'),
  mime_type          text NOT NULL,                  -- determined server-side from content
  declared_mime_type text,                           -- what the client claimed (audit only)
  kind               text NOT NULL CHECK (kind IN ('DOCUMENT','PRESENTATION','SPREADSHEET','TEXT','CODE','IMAGE')),
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket     text NOT NULL,
  storage_path       text NOT NULL,
  index_mode         text NOT NULL CHECK (index_mode IN ('RAG','EXTRACT_ONLY','STORAGE_ONLY')),
  status             text NOT NULL DEFAULT 'QUEUED'
                       CHECK (status IN ('QUEUED','PROCESSING','READY','STORED_ONLY','FAILED')),
  processing_error   text,
  processing_note    text,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at          timestamptz,
  extracted_chars    integer CHECK (extracted_chars IS NULL OR extracted_chars >= 0),
  page_count         integer CHECK (page_count IS NULL OR page_count >= 0),
  extraction_meta    jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_id        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT stored_files_location_uk        UNIQUE (storage_bucket, storage_path),
  CONSTRAINT stored_files_tenant_uk          UNIQUE (file_id, university_id, course_id),
  CONSTRAINT stored_files_university_uk      UNIQUE (file_id, university_id),
  CONSTRAINT stored_files_course_fk          FOREIGN KEY (course_id, university_id)
      REFERENCES public.courses (course_id, university_id),
  CONSTRAINT stored_files_classroom_fk       FOREIGN KEY (classroom_id, course_id, university_id)
      REFERENCES public.classrooms (classroom_id, course_id, university_id),
  CONSTRAINT stored_files_uploader_fk        FOREIGN KEY (uploader_id, university_id)
      REFERENCES public.users (user_id, university_id),
  CONSTRAINT stored_files_document_fk        FOREIGN KEY (document_id, university_id, course_id)
      REFERENCES public.documents (document_id, university_id, course_id) ON DELETE SET NULL (document_id),
  CONSTRAINT stored_files_failed_has_error   CHECK (status <> 'FAILED' OR processing_error IS NOT NULL),
  CONSTRAINT stored_files_rag_needs_classroom CHECK (purpose <> 'MATERIAL' OR classroom_id IS NOT NULL)
);
-- The RAG layer derives a document's identity from (university, course, content hash). Two RAG-indexed files with
-- identical bytes in one course would therefore be the SAME knowledge-base document and could not carry different
-- scopes, so the database refuses the second one (the API answers 409 with the existing file).
CREATE UNIQUE INDEX IF NOT EXISTS stored_files_rag_dedupe_uidx
  ON public.stored_files (university_id, course_id, sha256) WHERE index_mode = 'RAG';

CREATE OR REPLACE FUNCTION public.stored_files_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.university_id IS DISTINCT FROM OLD.university_id OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.extension IS DISTINCT FROM OLD.extension OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.classroom_id IS DISTINCT FROM OLD.classroom_id THEN
    RAISE EXCEPTION 'stored_files identity/ownership columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'QUEUED'      AND NEW.status IN ('PROCESSING','FAILED'))
      OR (OLD.status = 'PROCESSING'  AND NEW.status IN ('READY','STORED_ONLY','FAILED','QUEUED'))
      OR (OLD.status = 'FAILED'      AND NEW.status = 'QUEUED')
      OR (OLD.status IN ('READY','STORED_ONLY') AND NEW.status = 'QUEUED')
    ) THEN
      RAISE EXCEPTION 'invalid stored_files status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('READY','STORED_ONLY','FAILED') THEN NEW.processed_at := now(); NEW.locked_at := NULL; END IF;
    IF NEW.status = 'PROCESSING' THEN NEW.locked_at := now(); NEW.attempts := OLD.attempts + 1; END IF;
    IF NEW.status = 'QUEUED' THEN NEW.locked_at := NULL; END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stored_files_lifecycle_trg ON public.stored_files;
CREATE TRIGGER stored_files_lifecycle_trg BEFORE UPDATE ON public.stored_files
  FOR EACH ROW EXECUTE FUNCTION public.stored_files_lifecycle();

-- a file may only be attached where its declared purpose says it belongs
CREATE OR REPLACE FUNCTION public.assert_file_purpose() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE f public.stored_files%ROWTYPE;
BEGIN
  IF NEW.file_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO f FROM public.stored_files WHERE file_id = NEW.file_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'file % does not exist', NEW.file_id USING ERRCODE = 'foreign_key_violation'; END IF;
  IF f.purpose <> TG_ARGV[0] THEN
    RAISE EXCEPTION 'file % has purpose %, expected %', NEW.file_id, f.purpose, TG_ARGV[0]
      USING ERRCODE = 'check_violation';
  END IF;
  -- to_jsonb(NEW): this generic trigger also runs on tables that have no student_id column
  IF TG_ARGV[0] = 'SUBMISSION' AND f.uploader_id IS DISTINCT FROM (to_jsonb(NEW) ->> 'student_id') THEN
    RAISE EXCEPTION 'submission file was uploaded by a different user' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- materials
ALTER TABLE public.materials ADD COLUMN IF NOT EXISTS file_id text;
CREATE UNIQUE INDEX IF NOT EXISTS materials_file_uidx ON public.materials (file_id) WHERE file_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_file_fk') THEN
    ALTER TABLE public.materials ADD CONSTRAINT materials_file_fk
      FOREIGN KEY (file_id, university_id, course_id)
      REFERENCES public.stored_files (file_id, university_id, course_id) ON DELETE CASCADE;
  END IF;
END $$;
DROP TRIGGER IF EXISTS materials_file_purpose_trg ON public.materials;
CREATE TRIGGER materials_file_purpose_trg BEFORE INSERT OR UPDATE OF file_id ON public.materials
  FOR EACH ROW EXECUTE FUNCTION public.assert_file_purpose('MATERIAL');

-- ---------------------------------------------------------------- assignment attachments
CREATE TABLE IF NOT EXISTS public.assignment_attachments (
  attachment_id text PRIMARY KEY,
  assignment_id text NOT NULL,
  university_id text NOT NULL,
  course_id     text NOT NULL,
  file_id       text NOT NULL UNIQUE,
  role          text NOT NULL DEFAULT 'SUPPORTING' CHECK (role IN ('PROMPT','SUPPORTING')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_attachments_assignment_fk FOREIGN KEY (assignment_id, course_id, university_id)
      REFERENCES public.assignments (assignment_id, course_id, university_id) ON DELETE CASCADE,
  CONSTRAINT assignment_attachments_file_fk FOREIGN KEY (file_id, university_id, course_id)
      REFERENCES public.stored_files (file_id, university_id, course_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS assignment_attachments_one_prompt_uidx
  ON public.assignment_attachments (assignment_id) WHERE role = 'PROMPT';
DROP TRIGGER IF EXISTS assignment_attachments_purpose_trg ON public.assignment_attachments;
CREATE TRIGGER assignment_attachments_purpose_trg BEFORE INSERT OR UPDATE OF file_id ON public.assignment_attachments
  FOR EACH ROW EXECUTE FUNCTION public.assert_file_purpose('ASSIGNMENT_ATTACHMENT');

-- ---------------------------------------------------------------- submissions
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS file_id text;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_file_uidx ON public.submissions (file_id) WHERE file_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_file_fk') THEN
    ALTER TABLE public.submissions ADD CONSTRAINT submissions_file_fk
      FOREIGN KEY (file_id, university_id) REFERENCES public.stored_files (file_id, university_id);
  END IF;
END $$;
DROP TRIGGER IF EXISTS submissions_file_purpose_trg ON public.submissions;
CREATE TRIGGER submissions_file_purpose_trg BEFORE INSERT OR UPDATE OF file_id ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.assert_file_purpose('SUBMISSION');

-- ---------------------------------------------------------------- RAG documents: extra metadata (nullable; AI writes are unaffected)
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS mime_type        text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS extension        text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS size_bytes       bigint;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS document_kind    text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS processing_error text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS processed_at     timestamptz;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- private storage bucket (Supabase only)
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('course-materials', 'course-materials', false, 52428800)
    ON CONFLICT (id) DO UPDATE SET public = false;
  END IF;
END $$;

COMMIT;
