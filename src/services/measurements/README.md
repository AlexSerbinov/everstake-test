# Usage and cost accounting

![Runs, provider attempts, receipts and unknown costs](../../../docs/images/folder-costs.png)

A **run** is one operation, such as answering a question or updating a source. An **attempt** is one provider request inside that operation; retries create separate attempts. A **receipt** adds the operation's attempts and those of its child runs. This lets an evaluation show its total without losing the cost of each question.

Read the files in the order data travels:

| File                                   | What happens here                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [runs.ts](runs.ts)                     | Start and finish an operation; connect nested operations to their parent.                                          |
| [api-calls.ts](api-calls.ts)           | Save an attempt before sending the request, then record its usage or failure.                                      |
| [pricing.ts](pricing.ts)               | Convert reported usage into dollars using a dated price table.                                                     |
| [receipt.ts](receipt.ts)               | Build one operation's receipt, including child operations; expose safe attempt fields.                             |
| [cost-dashboard.ts](cost-dashboard.ts) | Group recorded attempts by purpose, provider and date; calculate query/update averages and the ×50 index forecast. |
| [import-ledger.ts](import-ledger.ts)   | Import saved measurements without charging for or replaying their requests.                                        |
| [types.ts](types.ts)                   | Define the usage records and receipts shared by callers.                                                           |
| [index.ts](index.ts)                   | Export the accounting functions used by other modules.                                                             |

In the dashboard, a call contributes once to each breakdown. A verification call belongs to its nearest question for query averages, and to its outermost operation for purpose totals. Completed runs with no unknown prices enter the averages; failed, unfinished or unpriced runs remain visible in totals. Public summaries omit visitors' question text.

`null` means the charge is unknown, not zero. The ×50 forecast scales recorded index-building cost and tokens; it does not include question embeddings or claim to be a measured larger-corpus bill. See [COST.md](../../../COST.md) for the accounting method and recorded evidence. Calculated usage costs are not automatically the same as a provider's final bill.

Run this folder's tests with `npx tsx --test --test-concurrency=1 'src/services/measurements/*.test.ts'`. They use in-memory databases and saved fixtures, with no paid provider calls.
