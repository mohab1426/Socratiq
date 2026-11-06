"""
Deterministic detection of *informational* questions the Coach must answer from authoritative
application data instead of coaching:

    identity    "What is my name?"                        -> authenticated student record
    assignment  "What is my assignment / requirements?"   -> assignments row
    materials   "What materials are available?"           -> materials catalog

Why this is a separate, rule-based step
---------------------------------------
The coaching pipeline (diagnose -> intervention -> response -> validate) is built to react to a
student's *work*. A bare factual question gives it nothing to diagnose, so the diagnosis comes back
UNCERTAIN, the intervention is forced to CLARIFICATION, and the answer is a Socratic deflection --
even though the answer is a plain database fact. Routing these questions deterministically makes
the behaviour independent of LLM judgement, and testable without a model.

Design rules (false positives are worse than false negatives)
-------------------------------------------------------------
* A message is routed here only when it is essentially JUST the question: after removing the
  matched question phrases and filler words, at most `MAX_RESIDUAL_WORDS` words may remain.
  "What is my assignment? I'm stuck on the gradient step" is a coaching message and is NOT routed.
* Only short messages (`MAX_MESSAGE_CHARS`) without code fences are considered.
* Anything not matched still reaches the normal pipeline, which now ALSO receives the same
  authoritative context block in its prompts (see `ai.agents.coach.context`), so paraphrased
  questions can still be answered correctly by the model.

Arabic patterns are written against `normalize_arabic_text()` output (hamza/alef variants folded,
teh-marbuta -> heh, alef-maksura -> yeh, diacritics removed).
"""
from __future__ import annotations

import re
from typing import Optional

from ai.rag.language import normalize_arabic_text

IDENTITY = "identity"
ASSIGNMENT = "assignment"
MATERIALS = "materials"
ASSIGNMENT_TOPICS = "assignment_topics"

MAX_MESSAGE_CHARS = 240
MAX_RESIDUAL_WORDS = 2

_NAME = r"(?:full\s+|first\s+|last\s+)?name"
_ASG = r"(?:assignment|homework|task)"
_MAT = r"(?:materials?|resources|readings?|documents?|files|lectures?|slides)"

_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    IDENTITY: [re.compile(p) for p in (
        rf"\bwhat(?:'s|s|\s+is|\s+are)\s+my\s+{_NAME}\b",
        r"\bwho\s+am\s+i\b",
        rf"\b(?:do\s+you\s+(?:know|remember)|tell\s+me|say)\s+my\s+{_NAME}\b",
        r"\bwhat\s+(?:do|should)\s+you\s+call\s+me\b",
        rf"^my\s+{_NAME}\s*\?",
        # Arabic (normalized)
        r"(?:^|\s)(?:ما|ما\s+هو|ماهو|ايه|اي|ايش|شو)\s+اسمي\b",
        r"\bاسمي\s+(?:ايه|اي|ايش|شو|ماذا)\b",
        r"\b(?:انا\s+مين|من\s+انا|مين\s+انا)\b",
        r"\b(?:هل\s+)?(?:تعرف|عارف|تفتكر|قولي|قل\s+لي|قللي)\s+اسمي\b",
    )],
    ASSIGNMENT: [re.compile(p) for p in (
        rf"\bwhat(?:'s|s|\s+is|\s+are)\s+(?:my|the|this|our)\s+(?:current\s+|active\s+)?{_ASG}\b",
        rf"\bwhat(?:'s|s|\s+is)\s+(?:this|my|the)\s+{_ASG}\s+about\b",
        rf"\b(?:describe|explain|summari[sz]e|tell\s+me\s+about)\s+(?:my|the|this)\s+(?:current\s+)?{_ASG}\b",
        # Assignment/application-context facts. These must use the trusted assignment record,
        # not the normal coaching pipeline.
        rf"\b(?:what|which)\s+(?:information|details|facts)\s+(?:do\s+you\s+(?:have|receive|know)|reach(?:es)?\s+you)\s+(?:about|for)\s+(?:my|the|this)\s+{_ASG}\b",
        rf"\bwhat\s+(?:do\s+you\s+know|information\s+do\s+you\s+have)\s+(?:about|on)\s+(?:my|the|this)\s+{_ASG}\b",
        rf"\bwhat\s+(?:information|details)\s+(?:about|for)\s+(?:my|the|this)\s+{_ASG}\b",
        rf"\b(?:the\s+)?(?:requirements?|instructions?|details|deliverables?|criteria)\s+(?:of|for|in)\s+(?:the|this|my|our)\s+(?:current\s+)?{_ASG}\b",
        rf"^(?:what(?:'s|s|\s+is|\s+are)\s+)?(?:the\s+|my\s+|this\s+)?(?:{_ASG}\s+)?(?:requirements?|instructions?|deliverables?|prompt|description)\s*[?.!]*$",
        rf"\bwhat\s+(?:do\s+i|should\s+i|am\s+i\s+supposed\s+to)\s+(?:need\s+to\s+|have\s+to\s+)?(?:do|submit|deliver|hand\s+in|turn\s+in)\s+(?:for|in)\s+(?:the|this|my)\s+{_ASG}\b",
        r"\bwhen\s+(?:is|are)\s+(?:it|this|that|the\s+assignment|my\s+assignment|the\s+homework)\s+due\b",
        rf"^(?:what(?:'s|s|\s+is)\s+)?(?:the\s+|my\s+)?(?:due\s+date|deadline)(?:\s+(?:for|of)\s+(?:this|the|my)\s+{_ASG})?\s*[?.!]*$",
        # Arabic (normalized)
        r"(?:ما|ما\s+هو|ماهو|ايه|ايه\s+هو|اي|ايش|شو)\s+(?:هو\s+)?(?:الواجب|التكليف|الاسايمنت|التاسك|المهمه|واجبي)\b",
        r"\b(?:الواجب|التكليف|الاسايمنت)\s+(?:بتاعي|بتاعتي|الحالي)\b",
        r"(?:متطلبات|تعليمات|تفاصيل|شروط|المطلوب(?:\s+(?:في|من))?)\s+(?:هذا\s+)?(?:الواجب|التكليف|الاسايمنت|المهمه)",
        r"(?:ايه|ايش|شو|ما)\s+(?:المعلومات|التفاصيل)\s+(?:اللي\s+)?(?:عندك|بتوصلك|وصلتك|واصلك)\s*(?:عن|بخصوص|من)\s*(?:الواجب|التكليف|الاسايمنت|المهمه)",
        r"(?:ايه|ايش|شو|ما)\s+(?:المعلومات|التفاصيل)\s+(?:اللي\s+)?(?:عندك|بتوصلك|وصلتك|واصلك)\b",
        r"(?:موعد|ميعاد|امتي|متي|اخر\s+موعد)\s+(?:ل)?(?:التسليم|تسليم|الواجب)",
        r"^(?:ما|ايه)?\s*(?:هو\s+)?(?:الديدلاين|ديدلاين|موعد\s+التسليم)\s*[؟?.!]*$",
    )],
    ASSIGNMENT_TOPICS: [re.compile(p) for p in (
        r"\bwhat\s+(?:are\s+)?(?:the\s+)?topics?\s+(?:(?:do|should)\s+)?i\s+(?:need\s+to\s+)?study\b",
        r"\bwhat\s+(?:is|are)\s+(?:the\s+)?(?:main|key|important)\s+(?:topics?|ideas?|points?)\s+(?:of|in|for)\s+(?:this|the|my)\s+(?:assignment|homework|task)\b",
        r"\bwhat\s+(?:are\s+)?(?:the\s+)?(?:main|key|important)\s+(?:topics?|ideas?|points?)\s+(?:in|of)\s+(?:the|this|my)\s+assignment\b",
        r"\bwhat\s+(?:topics?|concepts?|skills?)\s+(?:does|do)\s+(?:this|the|my)\s+assignment\s+(?:cover|include)\b",
        r"\bwhat\s+(?:are\s+)?(?:the\s+)?(?:main|key|important)\s+(?:ideas?|points?)\s+(?:in|of)\s+(?:the|this|my)\s+assignment\b",
        r"\bwhat\s+(?:topics?|concepts?|skills?)\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?(?:study|learn|review|understand)\b",
        r"\bwhat\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?study\s+(?:to\s+understand|before\s+starting)\s+(?:this|the|my)\s+(?:assignment|it)\b",
        r"\bwhat\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?study\s+to\s+understand\s+(?:it|this)\b",
        r"\bwhich\s+(?:topics?|concepts?)\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?(?:study|review|learn)\b",
        r"\bwhat\s+should\s+i\s+learn\s+(?:before|for)\s+(?:starting|doing)\s+(?:this|the|my)\s+assignment\b",
        r"(?:ايه|ايش|شو|ما)\s+(?:المواضيع|الموضوعات|المفاهيم|الحاجات)\s+(?:اللي\s+)?(?:لازم|محتاج|مفروض)\s+(?:اذاكر|ادرس|اتعلم|اراجع)(?:ها)?\b",
        r"(?:ايه|ايش|شو|ما)\s+(?:هي\s+)?(?:اهم|الاساسيه|الرئيسيه|الرئيسية)\s+(?:المواضيع|الموضوعات|النقاط|الافكار|الأفكار)\s+(?:في|بتاعة|بتاعت|بتوع)\s+(?:الواجب|التكليف|الاسايمنت|المهمه)\b",
        r"(?:ايه|ايش|شو|ما)\s+(?:المواضيع|الموضوعات|المفاهيم)\s+(?:اللي\s+)?(?:بيغطيها|يغطيها|بيتكلم\s+عنها|بتتكلم\s+عنها)\s+(?:الواجب|التكليف|الاسايمنت|المهمه)\b",
        r"(?:ايه|ايش|شو|ما)\s+(?:اللي\s+)?(?:لازم|محتاج|مفروض)\s+(?:اذاكر|ادرس|اتعلم|افهم)\s+(?:عشان|علشان|لفهم)\s+(?:الواجب|التكليف|الاسايمنت|المهمه)\b",
        r"\b(?:ايه|ايش|شو)\s+(?:المفاهيم|المواضيع)\s+(?:اللي\s+)?(?:اذاكرها|ادرسها|اراجعها)\b",
    )],
    MATERIALS: [re.compile(p) for p in (
        rf"\b(?:what|which)\s+(?:course\s+|class\s+)?{_MAT}\b.{{0,40}}\b(?:available|do\s+i\s+have|are\s+there|exist|uploaded|for\s+this\s+(?:course|class)|in\s+this\s+(?:course|class)|can\s+i\s+(?:use|access|see|read))\b",
        rf"\b(?:list|show|give)\s+(?:me\s+)?(?:all\s+)?(?:the\s+|my\s+)?(?:available\s+)?(?:course\s+|class\s+)?{_MAT}\b",
        rf"^(?:the\s+)?(?:available\s+)?(?:course|class)\s+{_MAT}\s*[?.!]*$",
        r"\bwhat\s+(?:can|should)\s+i\s+(?:study|read)\s+(?:for|in)\s+(?:this|the)\s+(?:course|class)\b",
        rf"\b(?:do\s+you\s+(?:know|have|see|have\s+access\s+to)|can\s+you\s+(?:see|access|read))\s+(?:the\s+|my\s+|this\s+)?(?:course\s+|class\s+)?{_MAT}\b",
        # Arabic (normalized)
        r"(?:ما|ما\s+هي|ماهي|ايه|ايه\s+هي|اي|ايش|شو)\s+(?:هي\s+)?(?:المواد|المحاضرات|الملفات|المراجع|المصادر|الماتيريال|الماتريال)\b",
        r"\b(?:المواد|المحاضرات|الملفات|المراجع)\s+(?:المتاحه|الموجوده|المرفوعه)\b",
        r"\bعندي\s+(?:ايه|اي)\s+(?:ملفات|محاضرات|مواد)\b",
        r"\b(?:تعرف|عارف|تقدر\s+تشوف|تشوف)\s+(?:المواد|المحاضرات|الملفات)\b",
    )],
}
# Explicit requests for locating/reviewing course material must force the RAG
# retrieval path. These are NOT the same as MATERIALS catalog questions
# ("what materials are available?"). They ask the Coach to locate relevant
# content inside the indexed course material.
_COURSE_MATERIAL_RETRIEVAL_PATTERNS = tuple(re.compile(p) for p in (
    # English: where/how to review, find, or locate material for the assignment.
    r"\b(?:where|how|whereabouts)\b.{0,80}\b(?:course\s+materials?|course\s+material|lecture\s+(?:notes?|slides?)?|slides?|notes?|readings?|chapters?|pages?)\b",
    r"\b(?:where|how)\b.{0,80}\b(?:review|revise|study|read|find|locate|access)\b.{0,80}\b(?:assignment|homework|task|this|it)\b",
    r"\b(?:which|what)\b.{0,50}\b(?:lecture|chapter|section|page|material|materials|notes?|slides?|reading)\b.{0,80}\b(?:review|revise|study|read|look|cover|covers|assignment|homework|task)\b",
    r"\b(?:where\s+can\s+i|where\s+do\s+i)\b.{0,80}\b(?:find|review|study|read|access)\b",
    # Arabic / Egyptian Arabic (after normalize_arabic_text).
    r"(?:فين|اين|أين|ازاي|كيف)\s+.{0,100}(?:المواد|الماده|ماتيريال|ماتريال|المحاضرات|المحاضره|الملفات|المراجع|المصادر|السلايدات|الشرائح|المذكرات)",
    r"(?:فين|اين|أين)\s+.{0,100}(?:الاقي|اجيب|ادخل|اشوف|اقدر\s+(?:اراجع|اذاكر|ادرس|اقرا|اوصل))\b",
    r"(?:انهي|اي|ما|ايه)\s+.{0,80}(?:محاضره|محاضرة|فصل|جزء|قسم|صفحه|صفحة|ملف|ماده|مادة|مواد)\s+.{0,80}(?:اراجع|اذاكر|ادرس|اقرا|مراجعه|للواجب|التكليف|الاسايمنت|المهمه)",
    r"(?:فين|اين|ازاي|كيف)\s+.{0,80}(?:اراجع|اذاكر|ادرس|اقرا|المراجعه)\s+.{0,80}(?:الواجب|التكليف|الاسايمنت|المهمه|ده|هذا|دي|دي)",
))


def is_explicit_course_material_request(message: Optional[str]) -> bool:
    """Return True when the student explicitly asks to locate/review course material.

    This flag is intentionally separate from ``classify_context_topics``. A material
    *catalog* question can be answered from application data, while a question such as
    "Where in the course material can I review this assignment?" requires semantic RAG.

    Work requests are excluded so a message like "where should I look, and solve it for
    me" still follows the normal Socratic workflow.
    """
    if not message or len(message) > MAX_MESSAGE_CHARS * 2 or "```" in message:
        return False
    text = _normalize(message)
    if not text:
        return False

    words = set(_WORD.findall(text))
    if words & _WORK_REQUEST:
        return False
    return any(pattern.search(text) for pattern in _COURSE_MATERIAL_RETRIEVAL_PATTERNS)


_FILLER = frozenset({
    "and", "also", "please", "pls", "plz", "hi", "hello", "hey", "tell", "me", "can", "you", "could", "just",
    "quickly", "now", "again", "so", "ok", "okay", "thanks", "thank", "btw", "the", "a", "is", "it", "coach",
    # Arabic
    "و", "ثم", "كمان", "لو", "سمحت", "فضلك", "بعد", "اذنك", "يا", "كوتش", "لي", "ممكن", "من", "في",
})
# Leftover words that ask for the WORK to be done. A message that also contains one is a coaching request that merely
# mentions the assignment ("What is my assignment? Just solve it for me"): it must reach the Socratic pipeline, never
# be treated as a factual lookup. (Arabic forms are written against normalize_arabic_text() output.)
_WORK_REQUEST = frozenset({
    "solve", "solving", "solved", "solution", "solutions", "answer", "answers", "answering", "complete", "finish",
    "implement", "write", "code", "cheat", "do", "doing",
    "حل", "احل", "حلي", "حله", "حلها", "الحل", "حلول", "اكتب", "اكتبي", "اعمل", "اعملي", "نفذ", "كمل", "كملي",
    "اجابه", "الاجابه", "جواب", "الجواب", "خلص", "خلصي",
})
_WORD = re.compile(r"\w+", re.UNICODE)
_TRAILING = re.compile(r"[\s؟?.!,،:;]+$")


def _normalize(message: str) -> str:
    text = normalize_arabic_text(message or "")
    text = text.replace("\u2019", "'").replace("\u2018", "'").lower()
    return re.sub(r"\s+", " ", text).strip()


def classify_context_topics(message: Optional[str]) -> list[str]:
    """Return the informational topics `message` is (essentially only) asking about, in a stable order.

    Empty list => normal coaching turn.
    """
    if not message or len(message) > MAX_MESSAGE_CHARS or "```" in message:
        return []
    text = _normalize(message)
    if not text:
        return []

    topics: list[str] = []
    residual = text
    for topic in (IDENTITY, ASSIGNMENT, ASSIGNMENT_TOPICS, MATERIALS):
        hit = False
        for pattern in _PATTERNS[topic]:
            if pattern.search(residual):
                hit = True
                residual = pattern.sub(" ", residual)
        if hit:
            topics.append(topic)
    if not topics:
        return []

    leftovers = [w for w in _WORD.findall(_TRAILING.sub("", residual)) if w not in _FILLER]
    if any(w in _WORK_REQUEST for w in leftovers):
        return []          # also asks for the work itself -> coaching, not a lookup
    if len(leftovers) > MAX_RESIDUAL_WORDS:
        return []          # a real coaching message that merely mentions one of these subjects
    return topics
