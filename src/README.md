# Server application

The TypeScript server exposes the API, runs research and collection work, and stores evidence in SQLite. Entry points and shared contracts sit here; focused modules hold the actual behavior.

Start with `application.ts` for wiring, [services](services/README.md) for features, and [workflows](workflows/README.md) for collection orchestration. These are modules in one application, not separately deployed services.

![Server modules and their responsibilities](../docs/images/folder-runtime.png)
