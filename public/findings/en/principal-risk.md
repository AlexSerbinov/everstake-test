# Control of keys does not eliminate principal loss risk

Reviewed: September 13, 2026. Finding type: overly broad risk wording. Status: the issue has been documented; correction of the original source and assistant verification remain pending.

## The issue

Everstake’s CFO guide states: “Maximum loss from operator failure: missed rewards only.” This suggests that maximum losses from operator failure are limited to missed rewards. A similar limitation appears in the table comparing staking models.

Another section of the same guide explains slashing: a protocol penalty can reduce the principal amount staked. Control of withdrawal keys protects against certain custody risks, but does not eliminate the consequences of validator rule violations.

A narrow reading of the first statement as specifically describing custody risk may be justified. The problem arises when it is used in isolation: in a table, presentation or short assistant answer, it sounds like a general guarantee of principal protection.

## Where to verify it

- [CFO guide](https://everstake.com/resources/blog/non-custodial-vs-managed-staking-risk-framework-cfos): compare Risk Dimension 1, Risk Dimension 2 and the summary matrix. The page lists an update date of September 10, 2026.
- [Everstake Terms of Use](https://everstake.com/terms-of-use): Section 5 describes the risk of asset loss through slashing and general limitations of liability.
- [Ethereum documentation on validator keys](https://ethereum.org/developers/docs/consensus-mechanisms/pos/keys): distinguishes signing keys from withdrawal authority; signing errors can lead to slashing.

## Why it matters to the business

A CFO may use the table to set a risk limit: if only income is at risk, reserves and approval procedures will differ from a situation involving possible principal loss. A convenient summary can remove the very condition that changes the decision.

Demonstration example: a client asks whether holding withdrawal keys guarantees that principal cannot be lost. The assistant finds the table and returns its conclusion with a correct citation. The link is real, but an answer without the slashing qualification would be too categorical. This is a proposed test scenario, not a recorded failure of the current system.

## What is established, and what is not

The comparison establishes the need to clarify the statement’s scope when citing it. The guide itself contains the necessary qualification, so the finding concerns consistency in risk presentation. We have not established actual losses, reviewed private SLAs or claimed that Everstake breached its obligations.

## Proposed response

- Separate the table into custody risks, downtime with missed rewards, and slashing with potential principal reduction.
- Place the slashing qualification immediately beside the short conclusion so it survives quotation.
- Agree on wording with the product owner and risk team; explain insurance and contractual compensation separately.
- Add an evaluation question about key control and principal. Success means the answer distinguishes the risks, cites sources and does not promise absolute protection.

## Work completed and follow-up

Sources have been compared and this document prepared. An owner has not yet been assigned. After implementation, add the agreed wording, updated page URL, reindexing date and actual assistant verification result here. Until then, the case remains open.
