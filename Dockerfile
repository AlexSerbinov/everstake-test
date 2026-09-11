# Runtime image: serves the API + UI over an already-built index (data/kb.db is mounted).
# No native modules — SQLite comes from Node itself (node:sqlite).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY prompts ./prompts
COPY public ./public
COPY eval ./eval
RUN npx tsc -p tsconfig.json
ENV NODE_ENV=production DATA_DIR=/data PORT=4320
EXPOSE 4320
CMD ["node", "dist/server/main.js"]
