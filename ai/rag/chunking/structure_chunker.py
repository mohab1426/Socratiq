"""
Structure-aware document chunker.

Splits parsed documents respecting headings, sections, code blocks, tables,
and definitions. Avoids naive fixed-length splitting and produces rich chunk metadata.
Configurable target range: 500-900 tokens with 80-120 token overlap.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Sequence

from ai.rag.chunking.concept_extractor import ConceptExtractor, get_concept_extractor
from ai.rag.config import get_rag_config
from ai.rag.ingestion.parser import ParsedDocument, ParsedPage
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata


def estimate_tokens(text: str) -> int:
    """Fast, accurate token estimation (approx 1 token per 3.8 characters)."""
    if not text:
        return 0
    words = len(text.split())
    chars = len(text)
    return max(words, int(chars / 3.8))


@dataclass
class SemanticBlock:
    """A discrete structural unit within a document page."""

    text: str
    content_type: ContentType
    heading_level: Optional[int] = None
    section: Optional[str] = None
    subsection: Optional[str] = None
    page_number: int = 1


class StructureAwareChunker:
    """Chunks documents respecting semantic and structural boundaries."""

    def __init__(
        self,
        min_tokens: Optional[int] = None,
        max_tokens: Optional[int] = None,
        overlap_tokens: Optional[int] = None,
        concept_extractor: Optional[ConceptExtractor] = None,
    ) -> None:
        cfg = get_rag_config()
        self.min_tokens = min_tokens or cfg.chunk_min_tokens
        self.max_tokens = max_tokens or cfg.chunk_max_tokens
        self.overlap_tokens = overlap_tokens or cfg.chunk_overlap_tokens
        self.concept_extractor = concept_extractor or get_concept_extractor(
            cfg.concept_extraction_mode
        )

    def chunk_document(
        self,
        parsed_doc: ParsedDocument,
        metadata: DocumentMetadata,
    ) -> list[DocumentChunk]:
        """Convert a ParsedDocument into a sequence of rich DocumentChunks."""
        if not parsed_doc.pages:
            return []

        # Step 1: Parse all pages into ordered semantic blocks with section tracking
        blocks = self._extract_semantic_blocks(parsed_doc.pages)
        if not blocks:
            return []

        # Step 2: Assemble semantic blocks into structure-aware chunks
        chunks: list[DocumentChunk] = []
        current_blocks: list[SemanticBlock] = []
        current_tokens = 0
        chunk_index = 0

        for block in blocks:
            block_tokens = estimate_tokens(block.text)

            # Special case: very large single block (e.g. huge code block or massive table)
            if block_tokens > self.max_tokens:
                # Flush existing buffer first
                if current_blocks:
                    chunks.append(
                        self._create_chunk(
                            current_blocks, metadata, parsed_doc.title, chunk_index
                        )
                    )
                    chunk_index += 1
                    current_blocks = []
                    current_tokens = 0

                # Split large block by sub-paragraphs or lines
                sub_chunks = self._split_large_block(
                    block, metadata, parsed_doc.title, chunk_index
                )
                chunks.extend(sub_chunks)
                chunk_index += len(sub_chunks)
                continue

            # Check if adding this block exceeds max_tokens or crosses a major section boundary
            major_section_change = False
            if current_blocks and block.heading_level in (1, 2):
                # When encountering a new H1 or H2, if we have reached min_tokens, close chunk
                if current_tokens >= self.min_tokens:
                    major_section_change = True

            if (current_tokens + block_tokens > self.max_tokens) or major_section_change:
                if current_blocks:
                    new_chunk = self._create_chunk(
                        current_blocks, metadata, parsed_doc.title, chunk_index
                    )
                    chunks.append(new_chunk)
                    chunk_index += 1

                    # Compute overlap blocks from end of current buffer
                    overlap_blocks = self._select_overlap_blocks(current_blocks)
                    current_blocks = list(overlap_blocks)
                    current_tokens = sum(estimate_tokens(b.text) for b in current_blocks)

            current_blocks.append(block)
            current_tokens += block_tokens

        # Flush final remaining blocks
        if current_blocks:
            chunks.append(
                self._create_chunk(
                    current_blocks, metadata, parsed_doc.title, chunk_index
                )
            )

        return chunks

    def _extract_semantic_blocks(self, pages: Sequence[ParsedPage]) -> list[SemanticBlock]:
        """Decompose pages into classified structural blocks with heading tracking."""
        blocks: list[SemanticBlock] = []
        current_section: Optional[str] = None
        current_subsection: Optional[str] = None

        for page in pages:
            lines = page.text.splitlines()
            idx = 0
            n = len(lines)

            while idx < n:
                line = lines[idx]
                stripped = line.strip()

                if not stripped:
                    idx += 1
                    continue

                # 1. Heading detection
                if stripped.startswith("#"):
                    heading_match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
                    if heading_match:
                        level = len(heading_match.group(1))
                        title = heading_match.group(2).strip()
                        if level <= 2:
                            current_section = title
                            current_subsection = None
                        else:
                            current_subsection = title

                        blocks.append(
                            SemanticBlock(
                                text=line,
                                content_type=ContentType.EXPLANATION,
                                heading_level=level,
                                section=current_section,
                                subsection=current_subsection,
                                page_number=page.page_number,
                            )
                        )
                        idx += 1
                        continue

                # 2. Code block fence (```)
                if stripped.startswith("```"):
                    code_lines = [line]
                    idx += 1
                    while idx < n and not lines[idx].strip().startswith("```"):
                        code_lines.append(lines[idx])
                        idx += 1
                    if idx < n:
                        code_lines.append(lines[idx])
                        idx += 1
                    code_text = "\n".join(code_lines)
                    blocks.append(
                        SemanticBlock(
                            text=code_text,
                            content_type=ContentType.CODE,
                            section=current_section,
                            subsection=current_subsection,
                            page_number=page.page_number,
                        )
                    )
                    continue

                # 3. Markdown table (lines starting with |)
                if stripped.startswith("|") and ("|" in stripped[1:]):
                    table_lines = [line]
                    idx += 1
                    while idx < n and lines[idx].strip().startswith("|"):
                        table_lines.append(lines[idx])
                        idx += 1
                    table_text = "\n".join(table_lines)
                    blocks.append(
                        SemanticBlock(
                            text=table_text,
                            content_type=ContentType.TABLE,
                            section=current_section,
                            subsection=current_subsection,
                            page_number=page.page_number,
                        )
                    )
                    continue

                # 4. Display Math Block ($$ ... $$)
                if stripped.startswith("$$"):
                    math_lines = [line]
                    idx += 1
                    while idx < n and not lines[idx].strip().endswith("$$"):
                        math_lines.append(lines[idx])
                        idx += 1
                    if idx < n:
                        math_lines.append(lines[idx])
                        idx += 1
                    math_text = "\n".join(math_lines)
                    blocks.append(
                        SemanticBlock(
                            text=math_text,
                            content_type=ContentType.FORMULA,
                            section=current_section,
                            subsection=current_subsection,
                            page_number=page.page_number,
                        )
                    )
                    continue

                # 5. Regular paragraph or list block
                para_lines = [line]
                idx += 1
                while idx < n and lines[idx].strip() and not lines[idx].strip().startswith(("#", "```", "|", "$$")):
                    para_lines.append(lines[idx])
                    idx += 1

                para_text = "\n".join(para_lines).strip()
                ctype = self._classify_paragraph_content_type(para_text)

                blocks.append(
                    SemanticBlock(
                        text=para_text,
                        content_type=ctype,
                        section=current_section,
                        subsection=current_subsection,
                        page_number=page.page_number,
                    )
                )

        return blocks

    def _classify_paragraph_content_type(self, text: str) -> ContentType:
        """Classify narrative text into specific pedagogical ContentType."""
        lower = text.lower()
        if (
            re.search(r"\b(definition|defined as|is defined to be)\b", lower)
            or re.match(r"^\*\*[^*]+\*\*\s*:\s*", text)
        ):
            return ContentType.DEFINITION
        if re.search(r"\b(example\b|for example|for instance|consider the case)\b", lower):
            return ContentType.EXAMPLE
        if re.search(r"\b(exercise\b|problem\b|practice problem|homework question)\b", lower):
            return ContentType.EXERCISE
        if re.search(r"\b(summary\b|key takeaways|in summary|recap)\b", lower):
            return ContentType.SUMMARY
        if (
            re.search(r"\b(formula|equation|theorem)\b", lower)
            or ("$" in text)
            or re.search(r"[=\^_\{\}\\]", text)
        ):
            return ContentType.FORMULA
        return ContentType.EXPLANATION

    def _select_overlap_blocks(self, blocks: list[SemanticBlock]) -> list[SemanticBlock]:
        """Pick trailing non-heading blocks to supply overlap context into the next chunk."""
        overlap: list[SemanticBlock] = []
        tokens = 0
        for block in reversed(blocks):
            # Do not overlap pure heading lines
            if block.heading_level is not None:
                continue
            b_tokens = estimate_tokens(block.text)
            if tokens + b_tokens > self.overlap_tokens:
                break
            overlap.insert(0, block)
            tokens += b_tokens
        return overlap

    def _create_chunk(
        self,
        blocks: list[SemanticBlock],
        metadata: DocumentMetadata,
        doc_title: str,
        chunk_index: int,
    ) -> DocumentChunk:
        """Combine blocks into a DocumentChunk and extract domain concepts."""
        combined_text = "\n\n".join(b.text for b in blocks).strip()
        first_block = blocks[0]
        page_num = first_block.page_number

        # Determine prevailing section and subsection
        section = next((b.section for b in blocks if b.section), None)
        subsection = next((b.subsection for b in blocks if b.subsection), None)

        # Primary content type: prioritize non-explanation types
        content_types = [b.content_type for b in blocks]
        non_expl = [t for t in content_types if t != ContentType.EXPLANATION]
        primary_type = non_expl[0] if non_expl else ContentType.EXPLANATION

        # Extract domain concepts
        concepts = self.concept_extractor.extract_concepts(
            combined_text, title=f"{doc_title} - {section or ''}"
        )

        return DocumentChunk(
            university_id=metadata.university_id,
            course_id=metadata.course_id,
            classroom_id=metadata.classroom_id,
            document_id=metadata.document_id,
            title=doc_title,
            page_number=page_num,
            section=section,
            subsection=subsection,
            concepts=concepts,
            content_type=primary_type,
            chunk_index=chunk_index,
            content=combined_text,
            token_count=estimate_tokens(combined_text),
        )

    def _split_large_block(
        self,
        block: SemanticBlock,
        metadata: DocumentMetadata,
        doc_title: str,
        start_index: int,
    ) -> list[DocumentChunk]:
        """Safely partition a single oversized block into sub-chunks."""
        lines = block.text.splitlines()
        chunks: list[DocumentChunk] = []
        current_lines: list[str] = []
        current_tokens = 0
        idx = start_index

        for line in lines:
            line_tokens = estimate_tokens(line) + 1
            if current_tokens + line_tokens > self.max_tokens and current_lines:
                text = "\n".join(current_lines).strip()
                chunks.append(
                    DocumentChunk(
                        university_id=metadata.university_id,
                        course_id=metadata.course_id,
                        classroom_id=metadata.classroom_id,
                        document_id=metadata.document_id,
                        title=doc_title,
                        page_number=block.page_number,
                        section=block.section,
                        subsection=block.subsection,
                        concepts=self.concept_extractor.extract_concepts(text, doc_title),
                        content_type=block.content_type,
                        chunk_index=idx,
                        content=text,
                        token_count=estimate_tokens(text),
                    )
                )
                idx += 1
                current_lines = []
                current_tokens = 0

            current_lines.append(line)
            current_tokens += line_tokens

        if current_lines:
            text = "\n".join(current_lines).strip()
            chunks.append(
                DocumentChunk(
                    university_id=metadata.university_id,
                    course_id=metadata.course_id,
                    classroom_id=metadata.classroom_id,
                    document_id=metadata.document_id,
                    title=doc_title,
                    page_number=block.page_number,
                    section=block.section,
                    subsection=block.subsection,
                    concepts=self.concept_extractor.extract_concepts(text, doc_title),
                    content_type=block.content_type,
                    chunk_index=idx,
                    content=text,
                    token_count=estimate_tokens(text),
                )
            )

        return chunks
