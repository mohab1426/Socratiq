"""Unit tests for the Coach's tool interfaces."""
from __future__ import annotations

import pytest

from ai.models.schemas import RetrievedContext
from ai.tools.code_analysis import CodeAnalysisTool
from ai.tools.course_retrieval import CourseRetrievalError, CourseRetrievalTool
from ai.tools.student_history import StudentHistoryError, StudentHistoryTool


def test_course_retrieval_filters_out_other_courses():
    def fake_retriever(course_id, query, top_k=4):
        return [
            RetrievedContext(source="lecture1", content="gradient descent", metadata={"course_id": "course_a"}),
            RetrievedContext(source="lecture2", content="unrelated", metadata={"course_id": "course_b"}),
            RetrievedContext(source="lecture3", content="no course tag"),
        ]

    # Permissive isolation retains untagged chunks
    permissive_tool = CourseRetrievalTool(retriever=fake_retriever, strict_isolation=False)
    results = permissive_tool.retrieve("course_a", "gradient descent")
    sources = {r.source for r in results}
    assert sources == {"lecture1", "lecture3"}

    # Strict isolation (default) drops untagged chunks and wrong course chunks
    strict_tool = CourseRetrievalTool(retriever=fake_retriever, strict_isolation=True)
    strict_results = strict_tool.retrieve("course_a", "gradient descent")
    strict_sources = {r.source for r in strict_results}
    assert strict_sources == {"lecture1"}


def test_course_retrieval_forwards_student_context_when_supported():
    captured = {}

    def context_aware_retriever(course_id, query, top_k=4, student_context=None):
        captured["student_context"] = student_context
        return []

    tool = CourseRetrievalTool(retriever=context_aware_retriever)
    tool.retrieve("course_a", "q", student_context={"message": "why is this wrong?"})
    assert captured["student_context"] == {"message": "why is this wrong?"}


def test_course_retrieval_tolerates_retriever_without_student_context_support():
    def legacy_retriever(course_id, query, top_k=4):
        return [RetrievedContext(source="ok", content="ok", metadata={"course_id": "course_a"})]

    tool = CourseRetrievalTool(retriever=legacy_retriever)
    # Must not raise even though legacy_retriever has no student_context param.
    results = tool.retrieve("course_a", "q", student_context={"message": "hi"})
    assert [r.source for r in results] == ["ok"]
    def malformed_retriever(course_id, query, top_k=4):
        return [
            RetrievedContext(source="valid", content="ok", metadata={"course_id": "course_a"}),
            RetrievedContext(source="none_course", content="none", metadata={"course_id": None}),
            RetrievedContext(source="wrong_type", content="bad", metadata={"course_id": 12345}),
            RetrievedContext(source="empty_meta", content="empty", metadata={}),
        ]

    tool = CourseRetrievalTool(retriever=malformed_retriever, strict_isolation=True)
    results = tool.retrieve("course_a", "query")
    assert len(results) == 1
    assert results[0].source == "valid"


def test_course_retrieval_requires_course_id():
    tool = CourseRetrievalTool()
    with pytest.raises(ValueError):
        tool.retrieve("", "query")


def test_course_retrieval_wraps_underlying_errors():
    def broken_retriever(course_id, query, top_k=4):
        raise RuntimeError("vector db down")

    tool = CourseRetrievalTool(retriever=broken_retriever)
    with pytest.raises(CourseRetrievalError):
        tool.retrieve("course_a", "query")


def test_student_history_wraps_underlying_errors():
    def broken_provider(student_id, assignment_id, concept=None, limit=3):
        raise RuntimeError("db timeout")

    tool = StudentHistoryTool(provider=broken_provider)
    with pytest.raises(StudentHistoryError):
        tool.retrieve("s1", "a1")


def test_student_history_default_provider_returns_empty():
    tool = StudentHistoryTool()
    assert tool.retrieve("s1", "a1") == []


def test_code_analysis_valid_syntax():
    tool = CodeAnalysisTool()
    code = "def f(x):\n    for i in range(10):\n        x = x + i\n    return x\n"
    result = tool.analyze(code)
    assert result.is_valid_syntax
    assert result.is_supported_language
    assert result.language == "python"
    assert "f" in result.defined_functions
    assert result.loops == 1


def test_code_analysis_invalid_syntax():
    tool = CodeAnalysisTool()
    result = tool.analyze("def f(x:\n    return x")
    assert not result.is_valid_syntax
    assert result.syntax_error
    assert result.is_supported_language


def test_code_analysis_unsupported_language():
    tool = CodeAnalysisTool()
    result = tool.analyze("public class Main {}", language="java")
    assert not result.is_supported_language
    assert not result.is_valid_syntax
    assert result.language == "java"
    assert "not supported" in result.syntax_error.lower()
