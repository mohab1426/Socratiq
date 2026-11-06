"""
Authoritative APPLICATION CONTEXT for the Coach.

Two kinds of facts reach the Coach and they must never be mixed up:

    Application / database context  -> WHO the student is, WHICH assignment (title, instructions,
                                       due date, attachments) and WHICH course materials exist.
                                       Supplied by the backend from relational rows for the
                                       AUTHENTICATED student (see backend/app/access.py). Exact,
                                       always available, never retrieved semantically.
    RAG context                     -> the CONTENT of course materials (passages relevant to the
                                       student's question), fetched through RetrievalScope.

This module is the single place where the first kind is turned into text, so every consumer
(response prompt, validator prompt, direct answers) sees identical facts.

Prompt-safety: the student's name, material titles and file names are free text, so they are
passed through `sanitize_untrusted_text`, flattened to one line and length-capped before entering
an LLM prompt. Assignment instructions are teacher-authored and go in verbatim (capped), exactly
as the diagnosis prompt already treats them.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from ai.agents.coach.context_questions import ASSIGNMENT, ASSIGNMENT_TOPICS, IDENTITY, MATERIALS
from ai.agents.coach.state import TaskContext
from ai.rag.language import is_arabic_dominant, normalize_arabic_text
from ai.rag.security import sanitize_untrusted_text

MAX_INSTRUCTIONS_IN_PROMPT = 4000
MAX_INSTRUCTIONS_IN_ANSWER = 3000
MAX_MATERIALS_LISTED = 50
_MAX_LINE = 120

_WS = re.compile(r"\s+")

def _field(obj, name: str, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)



def _display(text: Optional[str], limit: int = _MAX_LINE) -> str:
    """One line, whitespace collapsed, capped. For text shown to the student."""
    flat = _WS.sub(" ", text or "").strip()
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _prompt_line(text: Optional[str], limit: int = _MAX_LINE) -> str:
    """Like `_display` but neutralises prompt-injection phrasing. For text placed into an LLM prompt."""
    return _display(sanitize_untrusted_text(text or ""), limit)


def _cap_block(text: str, limit: int) -> tuple[str, bool]:
    text = (text or "").strip()
    return (text, False) if len(text) <= limit else (text[:limit].rstrip(), True)


def _materials(task: TaskContext) -> tuple[list, int]:
    raw = _field(task, "materials", []) or []
    shown = list(raw[:MAX_MATERIALS_LISTED])
    total = max(_field(task, "materials_total", 0) or 0, len(raw))
    return shown, total


# --------------------------------------------------------------------------------------------
# 1) Block injected into LLM prompts
# --------------------------------------------------------------------------------------------
def render_application_context(task: Optional[TaskContext], student_name: Optional[str]) -> str:
    """Render the authoritative context block ('' when there is nothing to say)."""
    if task is None:
        return ""
    lines: list[str] = []
    if student_name:
        lines.append(f"Student (the authenticated user you are talking to): {_prompt_line(student_name)}")
    university_name = _field(task, "university_name")
    if university_name:
        lines.append(f"University: {_prompt_line(university_name)}")
    course = " ".join(p for p in (_prompt_line(_field(task, "course_code")), _prompt_line(_field(task, "course_title"))) if p)
    if course:
        lines.append(f"Course: {course}")
    classroom_name = _field(task, "classroom_name")
    if classroom_name:
        lines.append(f"Classroom: {_prompt_line(classroom_name)}")

    lines.append(f"Current assignment: {_prompt_line(task.title, 200)}")
    if task.subject_area:
        lines.append(f"  Subject area: {_prompt_line(task.subject_area)}")
    due_at = _field(task, "due_at")
    lines.append(f"  Due: {_prompt_line(due_at) if due_at else 'no due date set'}")
    instructions, cut = _cap_block(task.instructions, MAX_INSTRUCTIONS_IN_PROMPT)
    lines.append("  Instructions / requirements:")
    lines.extend(f"    {ln}" for ln in (instructions.splitlines() or ["(none)"]))
    if cut:
        lines.append("    [instructions truncated]")
    declared = [_prompt_line(x, 80) for x in (_field(task, "concepts", []) or [])[:20] if x]
    if declared:
        lines.append("  Concepts the instructor tagged for this assignment: " + ", ".join(declared))
    attachments = _field(task, "attachments", []) or []
    if attachments:
        lines.append("  Attachments:")
        for a in attachments:
            role = _field(a, "role")
            label = "assignment prompt file" if role == "PROMPT" else "supporting file"
            lines.append(f"    - {_prompt_line(_field(a, 'filename'))} ({label})")

    shown, total = _materials(task)
    lines.append(f"Course materials available to this student ({total}):")
    if not shown:
        lines.append("  (none uploaded yet)")
    for m in shown:
        file_type = _field(m, "file_type")
        title = _field(m, "title")
        searchable = bool(_field(m, "searchable", False))
        kind = f" [{_prompt_line(file_type, 12)}]" if file_type else ""
        note = "" if searchable else " (download only: its contents are not searchable)"
        lines.append(f"  - {_prompt_line(title)}{kind}{note}")
    if total > len(shown):
        lines.append(f"  ... and {total - len(shown)} more")

    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# 2) Deterministic answers for the informational topics (English / Arabic)
# --------------------------------------------------------------------------------------------
_T = {
    "en": {
        "name": "Your name is {name}.",
        "no_name": "I don't have a name on file for your account.",
        "asg": 'Your current assignment is "{title}".',
        "course": "Course: {course}",
        "subject": "Subject: {subject}",
        "due": "Due: {due}",
        "no_due": "No due date has been set.",
        "reqs": "Requirements:",
        "cut": "(shortened - open the assignment page for the full text)",
        "attach": "Attachments:",
        "prompt_file": "assignment prompt file",
        "support_file": "supporting file",
        "asg_close": "I can't do the assignment for you, but I can help you work through it. Which part would you like to start with?",
        "mat_head": "Here are the materials available for {course}:",
        "mat_course": "this course",
        "dl_only": "download only, I can't read inside it",
        "more": "...and {n} more.",
        "mat_none": "There are no materials uploaded for {course} yet.",
        "mat_close": "Ask me about any of them and I'll use them to help you.",
    },
    "ar": {
        "name": "اسمك {name}.",
        "no_name": "لا يوجد اسم مسجّل لحسابك.",
        "asg": 'واجبك الحالي هو "{title}".',
        "course": "المقرر: {course}",
        "subject": "الموضوع: {subject}",
        "due": "موعد التسليم: {due}",
        "no_due": "لم يتم تحديد موعد تسليم.",
        "reqs": "المطلوب:",
        "cut": "(تم اختصار النص - افتح صفحة الواجب للاطلاع على النص الكامل)",
        "attach": "المرفقات:",
        "prompt_file": "ملف نص الواجب",
        "support_file": "ملف داعم",
        "asg_close": "لا أستطيع حل الواجب بدلًا منك، لكن يمكنني مساعدتك خطوة بخطوة. من أي جزء تريد أن نبدأ؟",
        "mat_head": "هذه هي المواد المتاحة لـ{course}:",
        "mat_course": "هذا المقرر",
        "dl_only": "للتحميل فقط ولا أستطيع القراءة داخله",
        "more": "...و{n} أخرى.",
        "mat_none": "لا توجد مواد مرفوعة لـ{course} حتى الآن.",
        "mat_close": "اسألني عن أي منها وسأستخدمها لمساعدتك.",
    },
}


def _identity_answer(t: dict, student_name: Optional[str]) -> str:
    name = _display(student_name)
    return t["name"].format(name=name) if name else t["no_name"]


def _assignment_answer(t: dict, task: TaskContext) -> str:
    out = [t["asg"].format(title=_display(task.title, 200))]
    course = " ".join(p for p in (_display(_field(task, "course_code")), _display(_field(task, "course_title"))) if p)
    if course:
        out.append(t["course"].format(course=course))
    if task.subject_area:
        out.append(t["subject"].format(subject=_display(task.subject_area)))
    due_at = _field(task, "due_at")
    out.append(t["due"].format(due=_display(due_at)) if due_at else t["no_due"])
    text, cut = _cap_block(task.instructions, MAX_INSTRUCTIONS_IN_ANSWER)
    out.append("")
    out.append(t["reqs"])
    out.append(text or "-")
    if cut:
        out.append(t["cut"])
    attachments = _field(task, "attachments", []) or []
    if attachments:
        out.append("")
        out.append(t["attach"])
        for a in attachments:
            label = t["prompt_file"] if _field(a, "role") == "PROMPT" else t["support_file"]
            out.append(f"- {_display(_field(a, 'filename'))} ({label})")
    out.append("")
    out.append(t["asg_close"])
    return "\n".join(out)


def _materials_answer(t: dict, task: TaskContext) -> str:
    course = _display(_field(task, "course_title")) or t["mat_course"]
    shown, total = _materials(task)
    if not shown:
        return t["mat_none"].format(course=course)
    out = [t["mat_head"].format(course=course)]
    for i, m in enumerate(shown, start=1):
        file_type = _field(m, "file_type")
        title = _field(m, "title")
        searchable = bool(_field(m, "searchable", False))
        kind = f" ({_display(file_type, 12)})" if file_type else ""
        note = "" if searchable else f" - {t['dl_only']}"
        out.append(f"{i}. {_display(title)}{kind}{note}")
    if total > len(shown):
        out.append(t["more"].format(n=total - len(shown)))
    if any(bool(_field(m, "searchable", False)) for m in shown):
        out.append("")
        out.append(t["mat_close"])
    return "\n".join(out)


def compose_context_answer(topics: list[str], task: TaskContext, student_name: Optional[str], message: str = "") -> str:
    """Answer the informational `topics` from authoritative data only. No model text is involved."""
    t = _T["ar" if is_arabic_dominant(message or "") else "en"]
    parts: list[str] = []
    if IDENTITY in topics:
        parts.append(_identity_answer(t, student_name))
    if ASSIGNMENT in topics:
        parts.append(_assignment_answer(t, task))
    if MATERIALS in topics:
        parts.append(_materials_answer(t, task))
    if ASSIGNMENT_TOPICS in topics:
        instructions = (_field(task, "instructions", "") or "").strip()
        title = _display(_field(task, "title"), 200)
        if is_arabic_dominant(message or ""):
            parts.append(
                f'الموضوعات الرئيسية في الواجب "{title}" يمكن تحديدها مباشرة من عنوان وتعليمات الواجب. '
                "وسأعتمد على التعليمات نفسها كمصدر الحقيقة.\n\n"
                f"{instructions[:MAX_INSTRUCTIONS_IN_ANSWER] if instructions else '- لا توجد تعليمات متاحة.'}"
            )
        else:
            parts.append(
                f'The main topics in "{title}" should be derived directly from the assignment title and instructions. '
                "I will use those instructions as the source of truth.\n\n"
                f"{instructions[:MAX_INSTRUCTIONS_IN_ANSWER] if instructions else '- No assignment instructions are available.'}"
            )
    return "\n\n".join(parts)


# --------------------------------------------------------------------------------------------
# 3) Grounding verification of MODEL-written informational answers
# --------------------------------------------------------------------------------------------
# The model may phrase an informational answer, but it may not add facts. These checks are deterministic and
# deliberately conservative: a false rejection only costs a fall back to the database-built template
# (`compose_context_answer`), whereas a false acceptance would let an invented fact reach the student.
#
# What is verified: every number/date token, weekday/month name, file name, URL/e-mail, quoted phrase and code
# snippet in the reply must occur in the evidence the model was given (the rendered context + the student's own
# question); every material the reply names must be a catalog entry; the student's name must be the authenticated
# one. What is NOT claimed: this is not a semantic entailment proof. Free prose that only re-arranges supplied facts
# is accepted; the prompt (ai.prompts.coach.context_answer_prompt) forbids everything else.
MAX_ANSWER_CHARS = 6000

_ARABIC_INDIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def _fold(text: Optional[str]) -> str:
    """Comparison form: NFKC, ASCII digits, Arabic letter variants folded, casefolded, whitespace collapsed."""
    t = unicodedata.normalize("NFKC", text or "").translate(_ARABIC_INDIC_DIGITS)
    return _WS.sub(" ", normalize_arabic_text(t).casefold()).strip()


_NUMBER = re.compile(r"\d+(?:[.,:/\-]\d+)*")
_LIST_MARKER = re.compile(r"(?m)^[ \t]*(?:[-*•–]|\d{1,3}[.)])[ \t]+")
_FILE_NAME = re.compile(
    r"[^\s\"'“”«»()\[\]<>,;]+\.(?:pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|rtf|ipynb|py|java|cpp|js|zip|png|jpe?g|gif|json|sql)\b"
)
_URL_OR_EMAIL = re.compile(r"https?://\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_QUOTED = re.compile(r'"([^"\n]{3,160})"|“([^”\n]{3,160})”|«([^»\n]{3,160})»')
_CODE_FENCE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
_CODE_INLINE = re.compile(r"`([^`\n]{2,160})`")

# Words that would introduce a date or time the context did not state. ("may" is omitted: it is a common verb.)
_TIME_WORDS = tuple(_fold(w) for w in (
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
    "tomorrow", "yesterday", "overdue",
    "السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة",
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
    "غدا", "بكرة", "أمس",
))
_MORE_LINE = re.compile(r"\bmore\b|اخر[يى]|اخرى")


def _has_word(haystack: str, word: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", haystack) is not None


def _has_number(evidence: str, token: str) -> bool:
    """`token` occurs in `evidence` as a whole numeric token (so '10' does not match inside '2026-10-01')."""
    return re.search(rf"(?<!\d)(?<!\d[.,:/\-]){re.escape(token)}(?!\d)(?![.,:/\-]\d)", evidence) is not None


def verify_assignment_response(
    response: str,
    *,
    task: TaskContext,
    student_name: Optional[str],
    intent: str,
) -> list[str]:
    """Validate an assignment-understanding response against the assignment record only.

    This compatibility wrapper is used by the current Coach graph. Assignment title and
    instructions are the authoritative source; assignment_concepts/assignment_materials
    are intentionally not consulted.
    """
    topics = [ASSIGNMENT_TOPICS if intent == ASSIGNMENT_TOPICS else ASSIGNMENT]
    application_context = "\n".join(
        part for part in (
            _display(_field(task, "title"), 200),
            _display(_field(task, "instructions"), MAX_INSTRUCTIONS_IN_ANSWER),
            _display(_field(task, "requirements"), MAX_INSTRUCTIONS_IN_ANSWER),
        ) if part
    )
    violations = verify_context_answer(
        response,
        [],
        topics=topics,
        task=task,
        student_name=student_name,
        application_context=application_context,
        question="",
    )

    if intent == ASSIGNMENT_TOPICS and not violations:
        folded_response = _fold(response)
        assignment_text = _fold(
            " ".join(
                part for part in (
                    _display(_field(task, "title")),
                    _display(_field(task, "instructions")),
                    _display(_field(task, "requirements")),
                ) if part
            )
        )
        # Require at least one meaningful assignment-derived anchor in a topic answer.
        anchors = [
            _fold(token) for token in re.findall(r"[A-Za-z]{4,}", assignment_text)
            if token and token not in {"this", "that", "with", "from", "your", "need", "must", "should", "assignment"}
        ]
        if anchors and not any(anchor in folded_response for anchor in anchors):
            violations.append("does not derive any study topic from the assignment record")

    return violations


def verify_context_answer(
    response: str,
    materials_mentioned: list[str],
    *,
    topics: list[str],
    task: TaskContext,
    student_name: Optional[str],
    application_context: str,
    question: str,
) -> list[str]:
    """Return the reasons `response` is not grounded in the supplied context (empty list => acceptable).

    The messages describe the rule that failed and never include student text, so they are safe to log.
    """
    violations: list[str] = []
    text = (response or "").strip()
    if not text:
        return ["empty response"]
    if len(text) > MAX_ANSWER_CHARS:
        violations.append("response is unreasonably long")

    evidence = _fold(f"{application_context}\n{question}")
    folded = _fold(text)
    body = _fold(_LIST_MARKER.sub("", text))          # ordered-list numerals are formatting, not facts

    for tok in dict.fromkeys(_NUMBER.findall(body)):
        if not _has_number(evidence, tok):
            violations.append("states a number/date that is not in the context")
            break
    for word in _TIME_WORDS:
        if _has_word(folded, word) and not _has_word(evidence, word):
            violations.append("introduces a day/month/time expression that is not in the context")
            break
    for name in dict.fromkeys(m.group(0) for m in _FILE_NAME.finditer(folded)):
        if name not in evidence:
            violations.append("names a file that is not in the context")
            break
    for ref in dict.fromkeys(m.group(0).rstrip(".,;:)") for m in _URL_OR_EMAIL.finditer(folded)):
        if ref not in evidence:
            violations.append("contains a link or e-mail address that is not in the context")
            break
    for m in _QUOTED.finditer(text):
        span = _fold(next(g for g in m.groups() if g))
        if span not in evidence:
            violations.append("quotes text that is not in the context")
            break
    code = [b for b in _CODE_FENCE.findall(text)] + _CODE_INLINE.findall(text)
    if any(_fold(c) not in evidence for c in code if c.strip()):
        violations.append("contains code that is not in the context")

    # --- materials must be catalog entries; a catalog-only question must not gain invented list items
    shown, total = _materials(task)
    catalog = {_fold(_prompt_line(_field(m, "title"))) for m in shown}
    for mentioned in materials_mentioned or []:
        if _fold(mentioned.strip(' "“”«»*_`')) not in catalog:
            violations.append("names a course material that is not in the catalog")
            break
    if MATERIALS in topics:
        if catalog and not any(title and title in folded for title in catalog):
            violations.append("does not name any of the available materials")
        if topics == [MATERIALS]:
            for line in text.splitlines():
                if not _LIST_MARKER.match(line):
                    continue
                item = _fold(_LIST_MARKER.sub("", line, count=1))
                if any(title and title in item for title in catalog):
                    continue
                if total > len(shown) and _MORE_LINE.search(item):
                    continue
                violations.append("lists an item that is not a catalog entry")
                break

    # --- identity: the authenticated student's name, never anything else
    if IDENTITY in topics and student_name and _fold(_display(student_name)) not in folded:
        violations.append("does not state the student's name from the record")

    # --- assignment: an over-refusal ("I can't see your assignment") is as wrong as an invention
    if ASSIGNMENT in topics:
        anchors = [_fold(_prompt_line(task.title, 200))]
        if getattr(task, "due_at", None):
            anchors.append(_fold(_prompt_line(getattr(task, "due_at", None))))
        anchors += [a for a in (_fold(ln)[:20] for ln in (task.instructions or "").splitlines()) if len(a) >= 8]
        if not any(a and a in folded for a in anchors):
            violations.append("does not state anything from the assignment record")
    return violations
