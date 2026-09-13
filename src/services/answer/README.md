# Research and answer checks

This module runs the researcher’s bounded search, read, and calculation loop. It assembles dated claims and citations, checks the output against retrieved evidence, and can request a repair or return an abstention.

Start with `answer-question.ts`. The [agent configuration](../../../agents/README.md) supplies guidance and limits. Model-based claim review adds another check, but does not guarantee factual correctness.
