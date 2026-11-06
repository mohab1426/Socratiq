# SocratiQ — Merged AI + Backend Architecture

This build merges the strongest parts of the two supplied versions without changing the database schema.

## Authoritative assignment understanding

The assignment's own `title`, `description/instructions`, `requirements`, and other trusted assignment fields are the primary source for understanding the assignment and deriving study topics.

`assignment_concepts` and `assignment_materials` are optional enrichment/retrieval relationships. They are **not required** for assignment understanding or topic extraction.

## Context boundaries

- **Application context:** authenticated student identity, assignment metadata, course/classroom metadata, policy, and other trusted relational facts.
- **Assignment-analysis context:** assignment title/instructions used to derive required concepts and study topics.
- **RAG context:** retrieved course-material content, restricted by backend-computed tenant/classroom/document scope.
- **Student-learning context:** prior evidence/history kept separate from course material.
- **Conversation context:** recent turns supplied by the backend.

## Coach routing

Narrow informational requests are detected deterministically, including English/Arabic identity, assignment, materials, and assignment-topic questions. Requests that also ask the Coach to do the student's work are deliberately kept on the normal Socratic pipeline.

Assignment-about and assignment-topic requests receive the assignment title/instructions directly in the response-generation prompt. They use deterministic grounding checks instead of a second LLM validation pass.

## LLM reliability

Logical model roles have independent configuration and ordered fallbacks:

- DEFAULT
- COACH
- REASONING
- LIGHTWEIGHT
- VERIFICATION

Fallback failures are handled without changing the public backend contract.

## RAG reliability

RAG retains hybrid retrieval, scoped authorization, reranking, source provenance, and embedding-dimension validation. The configured embedding dimension defaults to the database's declared 2048-dimensional vector unless explicitly overridden by environment configuration.

## Security

The backend remains the authorization boundary. Student identity, university, classroom, assignment access, and RAG document allowlists are derived from authenticated/database state, not student-supplied IDs or model output.

No real `.env` or credentials are included in this merged distribution.
