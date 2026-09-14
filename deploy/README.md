# Container setup

The Dockerfile uses the repository root as its build context. Compose paths are relative to `deploy/compose.yaml`; persistent data remains in root `data/` and `artifacts/`.

From the repository root, after preparing `.env` and the corpus as described in the [setup guide](../README.md):

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up -d --build
```

An empty data directory starts an empty application; building the image does not crawl sources or pay for embeddings. The service listens on host loopback port 4318. For a separate local copy, use another port/container name rather than replacing a running demo.

[scripts/deploy.sh](../scripts/deploy.sh) is the existing operator deployment for the personal server. It publishes a recorded commit, tests the image, retains the serving database and credentials, and imports saved evaluations. It is not required for local setup. Do not run it just to inspect this submission.
