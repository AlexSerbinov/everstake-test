from __future__ import annotations

import re
from dataclasses import dataclass

# Content is untrusted data. These patterns are applied before chunking, so suspect
# passages never enter the retrieval/generation context.
INSTRUCTION_PATTERNS = [
    re.compile(pattern, re.I)
    for pattern in (
        r"ignore (all |any )?(previous|prior|above) instructions?",
        r"(system|developer) prompt",
        r"you are (an?|the) (ai|assistant|chatbot|language model)",
        r"instructions? (for|to) (an? )?(ai|assistant|model|chatbot)",
        r"do not (answer|mention|reveal|say|follow)",
        r"when (an? )?(ai|assistant|model) (reads?|answers?|sees?)",
        r"respond (only|with|exactly)",
        r"(ai|language model) assistants? (should|must|do not)",
        r"guidelines? for (ai|language model) assistants?",
        r"what should (an? )?(ai|assistant|model) say",
    )
]


@dataclass
class SanitizedText:
    text: str
    removed_passages: list[str]


def sanitize_untrusted_text(text: str) -> SanitizedText:
    """Remove instruction-like paragraphs before indexing; retain an audit sample."""
    kept: list[str] = []
    removed: list[str] = []
    # Screen sentence-sized units: a canonical fact and an instruction can share
    # one HTML block, and quarantining that whole block would destroy good evidence.
    for line in text.splitlines():
        safe_sentences: list[str] = []
        for sentence in re.split(r"(?<=[.!?])\s+", line):
            if any(pattern.search(sentence) for pattern in INSTRUCTION_PATTERNS):
                removed.append(sentence[:500])
            else:
                safe_sentences.append(sentence)
        if safe_sentences:
            kept.append(" ".join(safe_sentences))
    return SanitizedText("\n".join(kept), removed)


def question_injection_reason(question: str) -> str | None:
    """Reject attempts to replace the evidence contract, while allowing normal questions."""
    patterns = (
        r"ignore (all |any )?(previous|prior|system|developer|tool) instructions?",
        r"(reveal|print|show) (the )?(system|developer) prompt",
        r"(do not|don't) (use|call|cite|verify) (the )?(tools?|sources?|evidence)",
        r"pretend (you|the answer|everstake)",
        r"answer (without|with no) (citations?|sources?|verification)",
        r"override (the )?(rules?|policy|guardrails?)",
    )
    return "The question attempts to override the evidence policy." if any(re.search(p, question, re.I) for p in patterns) else None
