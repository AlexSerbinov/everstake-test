FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY web web
COPY data/index-stats.json data/index-stats.json
ENV PYTHONUNBUFFERED=1 PORT=4321 EVERSTAKE_DB=/app/runtime/index.sqlite3 EVERSTAKE_COST_LOG=/app/runtime/run-costs.jsonl
EXPOSE 4321
CMD ["python", "-m", "app.server"]

