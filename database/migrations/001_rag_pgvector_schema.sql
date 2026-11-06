-- AUTHORITATIVE RAG CONTRACT. Keep aligned with existing ai/rag implementation.
CREATE TABLE IF NOT EXISTS public.documents (
  document_id text PRIMARY KEY,
  university_id text NOT NULL,
  course_id text NOT NULL,
  classroom_id text,
  uploader_id text,
  filename text NOT NULL,
  file_type text NOT NULL,
  storage_path text,
  content_hash text,
  upload_date timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','parsing','chunking','embedding','stored','failed')),
  total_pages integer CHECK (total_pages IS NULL OR total_pages >= 0),
  total_chunks integer CHECK (total_chunks IS NULL OR total_chunks >= 0),
  extra_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.document_chunks (
  chunk_id text PRIMARY KEY,
  university_id text NOT NULL,
  course_id text NOT NULL,
  classroom_id text,
  document_id text NOT NULL REFERENCES public.documents(document_id) ON DELETE CASCADE,
  title text,
  page_number integer CHECK (page_number IS NULL OR page_number >= 1),
  section text,
  subsection text,
  concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_type text NOT NULL DEFAULT 'explanation'
    CHECK (content_type IN ('definition','explanation','example','code','formula','table','summary','exercise')),
  assignment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  content text NOT NULL,
  embedding vector(2048),
  token_count integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  tsv_content tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig,
      coalesce(title,'') || ' ' || coalesce(section,'') || ' ' ||
      coalesce(subsection,'') || ' ' || coalesce(content,''))
  ) STORED,
  UNIQUE (document_id, chunk_index)
);


CREATE INDEX IF NOT EXISTS document_chunks_tsv_content_gin_idx
  ON public.document_chunks USING gin (tsv_content);
CREATE INDEX IF NOT EXISTS documents_scope_idx
  ON public.documents (university_id, course_id, classroom_id);
CREATE INDEX IF NOT EXISTS document_chunks_scope_idx
  ON public.document_chunks (university_id, course_id, classroom_id);
