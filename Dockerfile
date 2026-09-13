FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv ffmpeg && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ytdlp && /opt/ytdlp/bin/pip install --no-cache-dir yt-dlp
ENV PATH="/opt/ytdlp/bin:${PATH}"
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY public ./public
COPY config ./config
COPY agents ./agents
COPY skills ./skills
COPY prompts ./prompts
COPY eval ./eval
COPY scripts ./scripts
RUN npm run build:web
ENV NODE_ENV=production PORT=4318
EXPOSE 4318
CMD ["npm", "start"]
