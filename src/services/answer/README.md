# Research and answer checks

Start with `answer-question.ts`: it searches the corpus, asks the model for an action, executes that action, checks a final draft, and records the result. The [researcher definition](../../../assistant/agents/README.md) selects the prompt, evidence skill, and turn limits. A baseline run uses only the initial search and one generation turn.

## Follow one question

1. Search the local corpus and register the initial passages.
2. Ask the model to choose `search`, `read`, `calculate`, or `answer`. `research-action.ts` validates the JSON shape before any action runs.
3. Search can replace evidence in the bounded window. Read is limited to document IDs already returned by search. Calculations run locally and require cited sources with operands from those sources or the user's scenario.
4. For an answer, normalize claim dates, run local checks, retrieve counterevidence, then ask the claim reviewer to assess support. A rejected draft receives check reasons and the [repair instructions](../../../assistant/prompts/answer-repair.md), and may be repaired within the same bounded loop.
5. A valid answer is assembled from checked claims. Explicit abstention produces `no_reliable_answer`; provider failures, cancellation, and exhausted steps produce an error, not a claim that the fact is absent.
6. Save the answer and refresh the measured receipt before emitting the final events.

## Where each rule lives

| File | Responsibility |
| --- | --- |
| `answer-question.ts` | Orchestration, event order, repair budget, and persistence |
| `research-action.ts` | Accepted action fields and bounds; this does not establish factual support |
| `research-evidence.ts` | Bounded evidence window and source-backed calculation passages |
| `calculate.ts` | Arithmetic-only parser and scenario number recognition; never executes model code |
| `claim-date.ts` | Date provenance and dated rendering, distinguishing effective from observed dates |
| `verify-answer.ts` | Deterministic citation membership, number grounding, and date checks; no model calls |
| `counterevidence.ts` | Targeted searches for newer statements, exceptions, and related evidence |
| `verify-claims.ts` | Metered semantic review of claim support, currentness, exceptions, and whole-answer scope |

The evidence window keeps cited draft passages first, newly found passages second, and earlier passages last. It is deliberately bounded: a passage that fell out of the window cannot be cited without retrieving it again. Keeping draft citations during counterevidence retrieval allows a repair to retain valid evidence.

Research turns permit tools; extra repair turns permit only a final answer. The last research turn requests an answer, while the dispatcher enforces the no-tools boundary on repair turns. All model instructions and evidence are still untrusted inputs to the code checks. Semantic review adds scrutiny, but does not guarantee factual correctness: a repeated number alone also does not prove that the surrounding claim is supported.

For a live change, start with [policy](../../../assistant/config/policy.yaml), [researcher limits](../../../assistant/agents/researcher.yaml), or [model settings](../../../assistant/config/models.yaml). Run `npx tsx --test --test-concurrency=1 'src/services/answer/*.test.ts'` after changing answer behavior. Tests use fake model responses and in-memory databases; they do not measure live answer quality or make paid requests.

## Follow the semantic reviewer

`verifyClaims` reads from top to bottom in the order the checks run:

1. `reviewEveryClaim` asks for a support decision for every claim. Missing or repeated claim indexes trigger one retry; a second invalid response is an error.
2. `reviewNewerEvidenceAndExceptions` asks focused questions about newer passages and exceptions. These calls run in the reviewer's claim order, checking currentness before exceptions for each claim.
3. `formatClaimChecks` turns those decisions into the support, scope, and currentness reasons shown to the user and to the repair turn. It makes no model calls.
4. `reviewAnswerScope` checks whether the claims together answer the actual question without adding an unsupported relationship. It runs only when the earlier checks permit it.
5. `checkSynthesisEvidence` requires at least two independent source groups and two observation dates for a synthesis answer. Copies of one source cannot satisfy the independent-source requirement.

These steps stay in one file because they are one review workflow. The local citation, date, and number checks in `verify-answer.ts` run before this paid semantic review. A failed provider response remains an error; it is never counted as evidence that the corpus has no answer.
