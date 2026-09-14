# Automated checks

The check workflow installs dependencies, runs the project checks, and builds the browser application on pushes to `dev` and `main`, and on pull requests.

This is the CI configuration, not the application runtime. See the [root README](../../README.md) for local setup.

Open [check.yml](check.yml). It uses Node 22, installs the locked dependencies with `npm ci`, runs `npm run check` (types, offline tests and repository checks), then builds the browser JavaScript. A green run confirms these checks for that commit; it neither deploys the application nor runs a paid answer-quality evaluation.
