import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import os
import pytest
from sqlalchemy import create_engine, text
from dotenv import load_dotenv


load_dotenv()
URL = os.getenv("DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")

@pytest.fixture(scope="module")
def conn():
    engine = create_engine(URL, future=True)
    with engine.begin() as c:
        yield c

def test_tables(conn):
    required = {
      "documents","document_chunks","universities","users","students","professors","courses",
      "classrooms","enrollments","materials","concepts","assignments","assignment_concepts",
      "assignment_materials","document_chunk_assignments","document_chunk_concepts","attempts","submissions",
      "ai_sessions","ai_interactions","messages","ai_interaction_sources","verification_runs",
      "verification_questions","verification_responses","verification_results","learning_events",
      "evidence_candidates","evidence_sources","verification_question_evidence","risk_signals","student_concept_state"
    }
    got = set(conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).scalars().all())
    assert required <= got

def test_vector_dimension(conn):
    value = conn.execute(text("""
      SELECT format_type(a.atttypid,a.atttypmod)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='document_chunks'
        AND a.attname='embedding' AND NOT a.attisdropped
    """)).scalar()
    assert value == "vector(2048)"

def test_rag_indexes(conn):
    got = set(conn.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='document_chunks'")).scalars().all())
    assert "document_chunks_tsv_content_gin_idx" in got

def test_rag_insert_and_cleanup(conn):
    # Since migration 009 documents must hang off a real (university, course, classroom): tenant integrity is a DB guarantee.
    conn.execute(text("INSERT INTO universities(university_id,name) VALUES ('__u__','t') ON CONFLICT DO NOTHING"))
    conn.execute(text("INSERT INTO courses(course_id,university_id,code,title) VALUES ('__c__','__u__','__c__','t') ON CONFLICT DO NOTHING"))
    conn.execute(text("INSERT INTO classrooms(classroom_id,course_id,name,university_id) VALUES ('__cl__','__c__','t','__u__') ON CONFLICT DO NOTHING"))
    conn.execute(text("""
      INSERT INTO documents(document_id,university_id,course_id,classroom_id,filename,file_type,storage_path,processing_status)
      VALUES ('__test_doc__','__u__','__c__','__cl__','x.txt','text/plain','x/x','stored')
      ON CONFLICT (document_id) DO NOTHING
    """))
    conn.execute(text("""
      INSERT INTO document_chunks(chunk_id,university_id,course_id,classroom_id,document_id,title,content_type,assignment_ids,chunk_index,content)
      VALUES ('__test_chunk__','__u__','__c__','__cl__','__test_doc__','Test','explanation','["__a__"]'::jsonb,0,'Gradient descent uses a learning rate.')
      ON CONFLICT (chunk_id) DO NOTHING
    """))
    row = conn.execute(text("SELECT content_type, assignment_ids FROM document_chunks WHERE chunk_id='__test_chunk__'")).first()
    assert row is not None
    assert row.content_type == "explanation"
    assert row.assignment_ids == ["__a__"]
    conn.execute(text("DELETE FROM documents WHERE document_id='__test_doc__'"))
    for stmt in ("DELETE FROM classrooms WHERE classroom_id='__cl__'", "DELETE FROM courses WHERE course_id='__c__'", "DELETE FROM universities WHERE university_id='__u__'"):
        conn.execute(text(stmt))

def test_real_embedding_dense_retrieval():
    from ai.rag.embeddings.nvidia import NVIDIAEmbeddingProvider
    from ai.rag.storage.pgvector import PgVectorStore

    provider = NVIDIAEmbeddingProvider()

    text_value = "Gradient descent updates model parameters using a learning rate."
    document_embedding = provider.embed_documents([text_value])[0]
    query_embedding = provider.embed_query("How does gradient descent update parameters?")

    assert len(document_embedding) == 2048
    assert len(query_embedding) == 2048

    store = PgVectorStore()

    from sqlalchemy import create_engine, text

    engine = create_engine(URL, future=True)

    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO universities(university_id,name)
            VALUES ('__embed_u__','Embedding Test')
            ON CONFLICT DO NOTHING
        """))
        conn.execute(text("""
            INSERT INTO courses(course_id,university_id,code,title)
            VALUES ('__embed_c__','__embed_u__','__embed_c__','Embedding Test')
            ON CONFLICT DO NOTHING
        """))
        conn.execute(text("""
            INSERT INTO classrooms(classroom_id,course_id,name,university_id)
            VALUES ('__embed_cl__','__embed_c__','Embedding Test','__embed_u__')
            ON CONFLICT DO NOTHING
        """))
        conn.execute(text("""
            INSERT INTO documents(
                document_id,university_id,course_id,classroom_id,
                filename,file_type,storage_path,processing_status
            )
            VALUES (
                '__embed_doc__','__embed_u__','__embed_c__','__embed_cl__',
                'embedding.txt','text/plain','test/embedding.txt','stored'
            )
            ON CONFLICT (document_id) DO NOTHING
        """))

        conn.execute(text("""
            DELETE FROM document_chunks
            WHERE chunk_id = '__embed_chunk__'
        """))

        conn.execute(text("""
            INSERT INTO document_chunks(
                chunk_id,university_id,course_id,classroom_id,document_id,
                title,page_number,content_type,assignment_ids,chunk_index,content,embedding
            )
            VALUES (
                '__embed_chunk__','__embed_u__','__embed_c__','__embed_cl__',
                '__embed_doc__','Embedding Test',1,'explanation','[]'::jsonb,0,
                :content,:embedding
            )
        """), {
            "content": text_value,
            "embedding": document_embedding,
        })

    try:
        results = store.search_dense(
            course_id="__embed_c__",
            query_vector=query_embedding,
            top_k=5,
            university_id="__embed_u__",
            classroom_id="__embed_cl__",
        )

        assert results
        assert results[0].chunk.chunk_id == "__embed_chunk__"
        assert results[0].dense_score is not None
        assert results[0].dense_score > 0
    finally:
        with engine.begin() as conn:
            conn.execute(text("""
                DELETE FROM documents
                WHERE document_id = '__embed_doc__'
            """))
            conn.execute(text("""
                DELETE FROM classrooms
                WHERE classroom_id = '__embed_cl__'
            """))
            conn.execute(text("""
                DELETE FROM courses
                WHERE course_id = '__embed_c__'
            """))
            conn.execute(text("""
                DELETE FROM universities
                WHERE university_id = '__embed_u__'
            """))
