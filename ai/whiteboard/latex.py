"""LaTeX safety check for equations that come from the model OR the student before they are stored and rendered (KaTeX in the browser).

Allow-list based: only well-known math commands pass. This is not a LaTeX parser; the browser renderer additionally runs KaTeX with
`trust: false`, and falls back to plain text if rendering fails.
"""
from __future__ import annotations

import re
from typing import Optional

MAX_LATEX_CHARS = 400
MAX_DEPTH = 12

_GREEK = ("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega "
          "Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega").split()
_MATH = ("frac dfrac tfrac sqrt cdot times div pm mp leq geq neq approx le ge ne equiv sim propto ll gg sum prod int oint lim infty to rightarrow leftarrow "
         "Rightarrow Leftarrow leftrightarrow Leftrightarrow mapsto implies iff in notin subset subseteq supset cup cap emptyset forall exists neg land lor "
         "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp min max sup inf det dim gcd mod bmod partial nabla "
         "vec hat bar overline underline dot ddot text mathrm mathbf mathit mathbb mathcal operatorname left right quad qquad "
         "ldots cdots vdots ddots angle degree circ prime binom choose boxed lceil rceil lfloor rfloor langle rangle "
         "begin end limits displaystyle textstyle").split()
ALLOWED_COMMANDS = frozenset(_GREEK + _MATH)
ALLOWED_ENVIRONMENTS = frozenset({"matrix", "pmatrix", "bmatrix", "vmatrix", "cases", "aligned", "array"})
_ALLOWED_SYMBOL_ESCAPES = frozenset(",;:! {}|\\%&_#")

_CMD = re.compile(r"\\([A-Za-z]+|.)", re.S)
_ENV = re.compile(r"\\(?:begin|end)\{([A-Za-z*]+)\}")


def check_latex(src: Optional[str]) -> Optional[str]:
    """Return None if `src` is acceptable, otherwise a short reason."""
    if src is None or not src.strip():
        return "empty equation"
    if len(src) > MAX_LATEX_CHARS:
        return f"equation longer than {MAX_LATEX_CHARS} characters"
    if any(ord(c) < 32 and c not in "\n\t" for c in src):
        return "control characters are not allowed"
    depth = 0
    for ch in src:
        if ch == "{":
            depth += 1
            if depth > MAX_DEPTH:
                return "equation is nested too deeply"
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return "unbalanced braces"
    if depth != 0:
        return "unbalanced braces"
    for m in _CMD.finditer(src):
        name = m.group(1)
        if name.isalpha():
            if name not in ALLOWED_COMMANDS:
                return f"command \\{name} is not allowed"
        elif name not in _ALLOWED_SYMBOL_ESCAPES:
            return f"escape \\{name} is not allowed"
    for env in _ENV.findall(src):
        if env not in ALLOWED_ENVIRONMENTS:
            return f"environment {env} is not allowed"
    if len(re.findall(r"\\begin\b", src)) != len(re.findall(r"\\end\b", src)):
        return "unbalanced begin/end"
    return None
