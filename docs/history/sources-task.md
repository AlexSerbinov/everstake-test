# Task: wider sources with speaker-aware trust (YouTube discovery, "who is speaking", reported vs fact, contradiction handling)

Goal: grow the corpus beyond the company's own site with third-party talks, interviews and coverage — and make trust depend on **who is speaking and whether first-party evidence agrees**, not on where a page is hosted. The system must remain safe against defamation and fake claims: a third-party source can *report*, it can never *establish* a fact about the company on its own.

## 1. Discovery (YouTube first, same model for other third-party sources)

- Search YouTube with `yt-dlp "ytsearch60:Everstake"` plus variants (`"Everstake staking"`, `"Everstake interview"`, `"Everstake Devcon"`, `"Everstake Vasylchuk"`, `"Everstake Petrenko"`), the official channel `@Everstake`, and conference/podcast channels found this way. Metadata per video: id, title, description, channel, channel id, upload date, duration, views, subtitles availability.
- Relevance filter in code: "Everstake" must occur in title/description or ≥ 3 times in the transcript; reject look-alikes (EverRise, "es-fintech", "Everest") with a negative list; reject < 60 s clips and videos with no usable subtitles.
- Take auto-generated `en-orig` subtitles (free); store transcript with timestamps kept every ~60 s so citations can point to a minute.

## 2. Who is speaking (the core of the ranking)

- A **people registry** (`config/people.yaml`, seeded from the About page and the fact ledger: Vasylchuk, Kinitsky, Opryshko, Petrenko, Averin, Loiudice, Tkachenko … with roles and date ranges) — maintained as data, with a script that proposes additions from new About-page crawls.
- For each video: detect speakers from title/description (regex on registry names and "Everstake" + role words) and from the transcript's self-introductions ("I'm Anna, Head of R&D at Everstake"). Result: `voice` ∈ `first_party_channel` (official channel) | `employee_on_third_party` (registry match) | `third_party` (nobody from the company speaks) and `speakers[]`.
- Authority by voice, configurable in `kb.yaml`: official channel 0.7 (ASR quality caps it), employee on third-party 0.6, third-party 0.4, with the usual recency decay; plus a per-document `trust_penalty` (see §4). The same fields apply to press/blog pages: a quote from an employee in a news article is `employee_on_third_party`.
- UI: every source card shows the voice badge and speaker(s); the Corpus view can filter by voice.

## 3. Reported vs fact

- Fact extraction gets an `attribution` per fact: who states it (speaker/author) and whether that person/organisation is first-party. Facts from non-first-party voices are stored with `provenance = reported` (first-party = `stated`).
- The answerer receives provenance on every fact/source and must phrase reported material as "according to X (date)". Ledger ordering: `stated` first-party values first; `reported` values can *corroborate* or fill history when no first-party value exists, never override a first-party value of the same period.
- Gate 3 (numbers must be grounded) stays; add gate 3b: a numeric claim whose only grounding is `reported` is allowed only in reported phrasing (checked in code by looking for the attribution marker near the number).

## 4. Contradictions, defamation, fakes

- After fact extraction, a **consistency pass** (code, no model): for each key and period, compare `reported` values against `stated` first-party values; a source with ≥ 2 contradictions on verified keys gets `trust_penalty = 0.5` (stored on the document, shown in the UI with the reason); a `reported` fact with no first-party counterpart is flagged `unverified`.
- Answer rules (prompt + code): `unverified` claims are excluded from answers unless the question is explicitly about claims/rumours/opinions; negative claims about the company or a person are never stated from third-party-only sources — at most "X claims … (unverified)". The adversarial suite gets 4 new cases: a planted third-party page with a false negative claim, a planted "employee interview" transcript with a wrong number, a look-alike company video, and a real third-party video with an outdated number.
- Everything already in place remains: instruction stripping, tagged context, citation gate, live-page rule.

## 5. Deliverables

- Code + config + tests; new documents indexed (expect +20–60 videos and their transcripts); EVAL/ADVERSARIAL re-run for affected cases; REPORT: a "Sources and trust" section with the numbers (how many videos found, how many by voice class, how many contradictions/unverified flags); README: commands (`discover:youtube`, `people:sync`).
- Constraints: Gemini 3.x only; API spend ≤ ~$1 (transcripts are free; extraction on the new docs is the only model cost); code explainable; do not `git push`.
