"""
Lightweight static code-analysis tool for programming assignments.

Performs *safe*, non-executing analysis only (syntax check + simple
structural signals). It never executes student code -- if a future
sandboxed execution service is added, it should be wired in as a separate,
explicitly-scoped tool rather than extending this one.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Optional


class CodeAnalysisError(RuntimeError):
    pass


@dataclass
class CodeAnalysisResult:
    is_valid_syntax: bool
    syntax_error: Optional[str] = None
    defined_functions: list = field(default_factory=list)
    defined_variables: list = field(default_factory=list)
    used_names: list = field(default_factory=list)
    loops: int = 0
    line_count: int = 0
    language: str = "python"
    is_supported_language: bool = True


class CodeAnalysisTool:
    name = "code_analysis"

    def analyze(self, code: str, language: str = "python") -> CodeAnalysisResult:
        if language != "python":
            # Keep MVP scope: only Python AST analysis is supported today.
            return CodeAnalysisResult(
                is_valid_syntax=False,
                syntax_error=f"AST analysis only supported for Python; '{language}' is not supported.",
                line_count=len(code.splitlines()),
                language=language,
                is_supported_language=False,
            )

        try:
            tree = ast.parse(code)
        except SyntaxError as exc:
            return CodeAnalysisResult(
                is_valid_syntax=False,
                syntax_error=str(exc),
                line_count=len(code.splitlines()),
            )

        functions, variables, names, loops = [], [], set(), 0
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                functions.append(node.name)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        variables.append(target.id)
            elif isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, (ast.For, ast.While)):
                loops += 1

        return CodeAnalysisResult(
            is_valid_syntax=True,
            defined_functions=functions,
            defined_variables=variables,
            used_names=sorted(names),
            loops=loops,
            line_count=len(code.splitlines()),
        )
