# Audit answer

Before returning any answer:

1. Resolve every citation ref to exact evidence actually returned by a tool.
2. Reject unknown refs and require two distinct documents for synthesis.
3. Store the exact evidence, SHA-256 hashes, tool trace, question, answer, and as-of date.
4. Chain the record to its predecessor and sign its hash with Ed25519.
5. Return the receipt and verification URL. Never expose the private signing key.
