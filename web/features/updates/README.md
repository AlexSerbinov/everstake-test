# Updates: request collection work and watch its progress

Start with [updates-page.ts](updates-page.ts). `updatesPage()` returns the page node and a `destroy()` callback for [app.ts](../../app.ts). The page reads settings, source schedules, and durable job history from `/api/updates`.

Follow the nested functions in this order:

| Function | Responsibility |
| --- | --- |
| `load()` | Read saved server status and update the displayed progress. |
| `buildControls()` | Create an editable settings draft; later polling does not overwrite unsaved edits. |
| `mutate()` | Send an explicit settings change, update request, or retry, then reload status. |
| `poll()` | Schedule the next status read while the page is open. |
| `destroy()` | Stop polling and abort the page's requests when navigation disposes it. |

The main action requests all enabled sources. Persisted batches restore real source-job progress after reload; repeated clicks on an active pass show its progress. Failed sources retain their history and offer retry controls. Automatic execution has one global switch; frequency and priority are configured per source under the initially collapsed advanced settings.

The browser sends same-origin JSON actions without a token field. It polls status only: closing the page does not cancel jobs or start new paid work. The [server update module](../../../src/services/updates/README.md) owns the queue and schedules, including YouTube discovery and skipping already known video IDs. Explicit processing requests can incur provider costs.

Source labels, phases, and errors are rendered as text. Browser verification uses an isolated fixture server without provider calls.
