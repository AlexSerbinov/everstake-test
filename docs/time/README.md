# Effort-accounting evidence

Recorded events and small analysis scripts support the project’s effort accounting. They help reconstruct intervals while keeping human activity separate from autonomous agent elapsed time.

Read [TIME.md](../TIME.md) for the method, totals, and uncertainty. Event timestamps alone are not a complete timesheet.

## Files and their limits

| File | What it does |
| --- | --- |
| [events.csv](events.csv) | Saved timestamps used in the retrospective analysis. |
| [count.py](count.py) | Groups nearby events into estimated activity blocks; its gap and minimum-duration rules are heuristics. |
| [extract-local.py](extract-local.py) | Author-only extraction from local session and dictation records; those private inputs are not in this repository. It writes `events.csv`, so reviewers do not need to run it. |

You can inspect the saved calculation with `python3 docs/time/count.py` from the repository root. Its estimate does not prove continuous human activity or absence between events. The method and qualifications in [TIME.md](../TIME.md) take precedence; [TIMELOG.md](../../TIMELOG.md) explains the tasks behind the reported effort.
