# Browser features

Each folder groups the rendering and interaction logic for one user-facing area, such as questions, answers, sources, evaluations, or updates. This keeps page behavior near the feature it belongs to.

The [web entry point](../README.md) connects these pieces. Shared DOM helpers and server-event parsing live outside the feature folders.
