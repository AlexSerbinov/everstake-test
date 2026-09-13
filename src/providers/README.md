# Model-provider clients

Adapters connect the application to Gemini and OpenAI, handling requests, failures, and reported usage. They give feature modules a shared interface to external models.

Model choices live in [config](../../config/README.md). These clients transport requests and responses; evidence selection and answer validation belong to the calling services.
