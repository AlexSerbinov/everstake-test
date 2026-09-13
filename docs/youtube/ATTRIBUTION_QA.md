# YouTube attribution editorial QA

Reviewed on 2026-09-13 against the cached Soniox turns and the supplied metadata already stored in `artifacts/youtube/inventory.json`. No external identity source or additional paid model call was used. The original transcript text and input hashes remain unchanged. Each edited cache carries a top-level `editorialReview` object with field-level provenance.

| Video | Editorial change | Supplied provenance | Gate effect |
| --- | --- | --- | --- |
| `beakNs8F3pQ` | `Alex Cahaya` → `Alex Kehaya`; `Sergey Vasychuk` → `Sergey Vasylchuk` | Inventory description names host Alex Kehaya and guest Sergey Vasylchuk; the title independently names Sergey Vasylchuk. | Source remains `reviewed`; employee turns keep their prior eligibility. |
| `DFSEQ3OGoL8` | `Sergey Vasilchuk` → `Sergey Vasylchuk` | Inventory title and description use Sergey Vasylchuk for the same Everstake guest introduced in turn 0. | Source remains `reviewed`; employee turns keep their prior eligibility. |
| `CDmKMHaTtSQ` | `Sergey Vasilchuk` → `Sergii Vasylchuk` | Inventory title and description use Sergii Vasylchuk for the founder and CEO introduced in turn 0. | Source remains `needs_review`, so no turn is eligible. |
| `V0WcDdiJAeg` | `Anna` → `Anna Petrenko` | Inventory title names Anna Petrenko at Everstake; the description and turn 1 both identify Anna as Head of R&D at Everstake. | Source remains `reviewed`; this replaces a first-name-only eligible attribution with the supplied full name. |
| `GZ5NsQDP_Bc` | `Bohdan` → `Bohdan Opryshko` | Inventory description names guest Bohdan Opryshko, COO of Everstake; turns 0 and 4 identify the same first name and role. | Source remains `needs_review`, so no turn is eligible. |
| `d8EtzF2qhMM` | Excluded turn 7 from evidence. | The video was published on 2026-04-23 and its supplied description discusses recent Iran tensions; turn 7 says the event began in “February 2028.” | Eligible employee turns decrease from 19 to 18. |
| `rIFtUSKa-fQ` | `roleAtRecording: "CEO"` → `null`. | The supplied title identifies Bohdan Opryshko as Everstake COO, while turn 5 is transcribed as CEO, a likely CEO/COO phonetic ambiguity. | Source remains `needs_review`, so no turn is eligible. |
| `PyLJVoCAnRI` | Retained `Marissa True` but flagged it as an uncorroborated phonetic rendering. | Turn 0 supplies that rendering; the inventory title and description do not name the host. | Host turns are interviewer material and remain ineligible. |

The first two review failures were output truncations rather than malformed prompt input. Both initial calls used 4,996 output tokens: 4,803 thinking tokens and only 193 visible tokens. The JSON therefore ended mid-string. The successful `d8EtzF2qhMM` call used 3,210 output tokens: 2,801 thinking and 409 visible. Raising the review ceiling allowed the failed items to return complete JSON; for example, the retry of `-uo63ka1zoo` used 9,964 output tokens, including 8,500 thinking tokens.

No completed `reviewed` source let an interviewer turn become company evidence: the eligibility gate still requires a reviewed source and an identified Everstake employee label. Interviewer premises such as 60 versus 120 employees and the derived USD 9 million event-spend estimate in `V0WcDdiJAeg` are explicitly excluded. The main remaining content risk is transcription accuracy inside genuine employee turns, which is why the impossible 2028 date was quarantined instead of corrected.
