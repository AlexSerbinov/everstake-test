FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY web web
COPY agents agents
COPY prompts prompts
COPY config config
COPY data/index-stats.json data/index-stats.json
COPY data/cost-report.json data/cost-report.json
COPY data/freshness-policy.json data/freshness-policy.json
ENV PYTHONUNBUFFERED=1 PORT=4321 EVERSTAKE_DB=/app/runtime/index.sqlite3 EVERSTAKE_CORPUS=/app/runtime/corpus.jsonl EVERSTAKE_COST_LOG=/app/runtime/run-costs.jsonl EVERSTAKE_ACCOUNTING_LOG=/app/runtime/accounting.jsonl EVERSTAKE_AUDIT_LOG=/app/runtime/answer-audit.jsonl EVERSTAKE_SIGNING_PATH=/app/runtime/audit-ed25519.key EVERSTAKE_TRUST_CONFIG=/app/runtime/trust-score.json EVERSTAKE_MACHINE_LABEL="Hetzner VPS (production container)"
EXPOSE 4321
CMD ["python", "-m", "app.server"]
