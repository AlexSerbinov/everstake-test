# Shared: small building blocks used by several pages

Start with [dom.ts](dom.ts) when following how a page creates its interface. Start with [source-date.ts](source-date.ts) when following a date or source-authority label.

| File | What belongs here |
| --- | --- |
| [dom.ts](dom.ts) | Text-only elements, buttons, safe HTTP(S) links, disclosures, badges, empty states, JSON reads, money formatting, and metric cards. |
| [source-date.ts](source-date.ts) | Date formatting that preserves year/month-only precision, UTC timestamps, and source-authority labels. |

`el()` inserts text with `textContent`; `link()` rejects executable URL schemes. `getJson<T>()` checks HTTP success, but its TypeScript type is not runtime response validation. Unknown dates stay visibly unknown.

These helpers are imported by [feature pages](../features/README.md) and [app.ts](../app.ts). Keep page-specific state and actions in the owning feature folder; a helper belongs here when several pages need it.
