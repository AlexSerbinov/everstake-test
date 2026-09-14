# Findings: display the published research documents

Start with [findings-page.ts](findings-page.ts), which selects a document and language, fetches its Markdown, and mounts the result. [catalog.ts](catalog.ts) lists the allowed documents; [document.ts](document.ts) turns their supported Markdown into safe DOM elements.

An editorial document collection at `#findings`, with stable routes such as `#findings/principal-risk`. The reviewed source cases are separate from runtime answers and measured evaluation results.

Edit the canonical Markdown files in [public/findings](../../../public/findings/). Each document records the problem, evidence, consequences, limits, proposed response and follow-up. Sources have an explicit research date; implementation and owner assignment remain pending unless verified work is recorded. The same file is displayed and downloaded, so there is no second body to synchronize.

Add catalog metadata in [catalog.ts](catalog.ts) for a new document. [document.ts](document.ts) supports headings, paragraphs, bullet lists and links; it constructs text nodes and allows only HTTP(S) external links. It does not execute HTML or support arbitrary Markdown extensions. Unknown IDs never become fetch paths. Load errors offer a retry.

The three original cases were rechecked on 2026-09-13; NIST CSF assurance scope is an additional finding. Prototype probe results are deliberately not presented as measurements of the rebuilt assistant.

The Findings-only English / Українська selector defaults to English and stores its choice in `localStorage` under `findings-language`. It does not change the application navigation or other sections. Ukrainian documents retain their stable `public/findings/*.md` URLs; complete English counterparts are in `public/findings/en/`. Keep source URLs, review dates and limitations aligned in both versions. The visible document and download use the selected language, with `.en.md` / `.uk.md` download names. Catalog metadata is localized in [catalog.ts](catalog.ts).
