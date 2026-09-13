# Feature modules

Each folder owns a specific job: collecting documents, building the index, searching evidence, researching answers, tracking usage, or updating sources. Keeping these jobs separate makes their rules and tests easier to inspect.

They run inside one application. Start with [answer](answer/README.md) for a question’s path, or [workflows](../workflows/README.md) for how the collection is built and refreshed.
