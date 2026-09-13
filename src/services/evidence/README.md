# Evidence sanitation

Removes document text that explicitly instructs an AI or asks for hidden prompts.
Start with `sanitize-document.ts`.
Input is extracted visible text and output is safe text plus an audit list of removed sentences.
Ordinary product instructions and API commands remain available as evidence.
The crawler stores the removal audit in snapshot metadata before indexing.
Tests cover malicious instructions and preservation of useful imperative prose.
