# Task: Trust Score for every answer — a number, and what it is made of

Goal: every answer gets a **Trust Score (0–100)** that a non-engineer understands at a glance, plus a breakdown of *why*: which factors pushed it up or down, with weights. It must be computed by **code, deterministically**, from things the system already measures (never asked from the model), and it must be explainable on screen and in the API.

## Worked intuition (from the owner)

- "Who is the CEO?" — three sources, all first-party, all say the same, newest one fetched today → high score (90+).
- Same question, two obscure third-party pages say person A, the company's own page says person B → the answer is B, and the score is *lower* than the first case, but the breakdown shows why: agreement is split, yet the sources that agree with the answer are the authoritative ones, and the disagreeing ones are low-trust. The score must carry both the number and its composition ("score and weight").

## Components (each 0–1, with a weight from config; final = 100 × Σ wᵢ·cᵢ, clamped)

1. **Source authority** — best and average authority of the *cited* sources: first-party site/docs/GitHub > employee voice on a third-party channel > third-party; live-verified page counts higher; documents with a `trust_penalty` or `unverified` flags count lower.
2. **Independent agreement** — how many *independent* cited sources support the core claim(s). Independence: a dedup cluster is one source; syndicated copies of a press release are one source; the same domain twice is one source. Disagreement among cited/considered sources (e.g. ledger has conflicting values for the same key and period) lowers this, *unless* the disagreeing sources are low-authority (then the penalty is small and is shown as "2 low-trust sources disagree").
3. **Recency / currency** — age of the newest supporting first-party source relative to the question's nature (a "current state" question wants a recent or live source; a historical question does not), and whether the answer's `as_of` is recent.
4. **Grounding** — results of the gates: all citations valid, all numbers grounded in tool results, no `reported`-only numbers stated as fact; number of claims vs number of cited sources.
5. **Extraction confidence** — when the answer relies on ledger facts, the extractor's confidence and whether the `as_of` came from the text or from the document date.
6. **Model self-assessment** — the model's `confidence` is allowed as one *minor* component (weight ≤ 10%), and it is shown separately so nobody mistakes it for the score.

Bands with plain labels: 90–100 "Solid: several independent first-party sources agree"; 70–89 "Good: first-party, some caveats"; 50–69 "Mixed: sources disagree or are third-party"; < 50 "Weak: treat as a lead, verify"; abstentions have no score but show what was missing.

## Where it shows

- **Answer card**: a score badge (number + band colour + label) next to the status; hover/click opens the **breakdown**: one row per component with its weight, its value, the contribution in points, and a one-line plain-language reason ("3 independent first-party sources agree · +28"; "1 third-party source disagrees (low trust) · −4"; "newest supporting page fetched today · +18"). Per-source cards show the source's own authority and whether it supports or contradicts the answer.
- **API**: `trust: { score, band, label, components: [{name, weight, value, points, reason}], independent_sources, disagreements: [...] }` in `AskResult` and in the `final` SSE event; also in the receipt/step trace so the pipeline panel can show "verify → trust score computed".
- **Eval**: EVAL.md and the adversarial report get a Trust Score column; show that correct answers score high, abstentions have none, and the adversarial "wrong number from a fake page" cases score low — that correlation *is the validation* of the score. Report the correlation (e.g. mean score for correct vs partially correct rows).
- **Settings**: weights editable live (same override mechanism as other config), so a reviewer can ask "make agreement matter more" and see scores change.
- **Docs**: `docs`/REPORT section "Trust Score": formula, weights, what it can and cannot tell (it measures evidence quality, not truth), and the eval correlation; DEFENCE-style plain summary.

## Constraints

Deterministic code + unit tests for each component and for the two worked examples above (build them as fixtures). No new model calls. Gemini 3.x only where a model is involved elsewhere. Keep API spend ≈ $0 for this task beyond re-running the eval table once (≤ $1). Do not `git push`.
