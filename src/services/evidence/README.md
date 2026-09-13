# Evidence sanitation

Removes recognized sentences that address an AI with instructions, while preserving ordinary product instructions and API commands. The crawler stores an audit of removed text before indexing.

Start with `sanitize-document.ts`. This filter reduces exposure; it does not make arbitrary source text trustworthy. The [answer module](../answer/README.md) also constrains actions and checks citations and support.
