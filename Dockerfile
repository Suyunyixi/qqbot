FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN python3 -m venv /opt/media \
    && /opt/media/bin/pip install --no-cache-dir --timeout 120 --retries 8 --index-url="$PYPI_INDEX_URL" yt-dlp==2026.10.26
ENV PATH="/opt/media/bin:${PATH}" NODE_ENV=production BOT_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit --no-fund --registry="$NPM_REGISTRY" --replace-registry-host=always --fetch-retries=6 --fetch-retry-mintimeout=2000 --fetch-timeout=120000 \
    || (tail -n 100 /root/.npm/_logs/*-debug-0.log && exit 1)
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev && mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node
EXPOSE 8765
CMD ["node", "dist/index.js"]
