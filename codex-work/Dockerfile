FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY web web
COPY agents agents
COPY prompts prompts
COPY data/index-stats.json data/index-stats.json
ENV PYTHONUNBUFFERED=1 PORT=4321 EVERSTAKE_DB=/app/runtime/index.sqlite3 EVERSTAKE_CORPUS=/app/runtime/corpus.jsonl EVERSTAKE_COST_LOG=/app/runtime/run-costs.jsonl EVERSTAKE_AUDIT_LOG=/app/runtime/answer-audit.jsonl EVERSTAKE_SIGNING_PATH=/app/runtime/audit-ed25519.key
EXPOSE 4321
CMD ["python", "-m", "app.server"]
