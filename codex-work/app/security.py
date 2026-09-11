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
    for paragraph in re.split(r"\n\s*\n", text):
        if any(pattern.search(paragraph) for pattern in INSTRUCTION_PATTERNS):
            removed.append(paragraph[:500])
        else:
            kept.append(paragraph)
    return SanitizedText("\n\n".join(kept), removed)

