FROM node:22-slim
WORKDIR /app

# Playwright / Chromium dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install deps
COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/
RUN npm install --workspace=@hermes/backend --omit=dev

# App source
COPY apps/backend/src apps/backend/src

# Data directory for sessions and SQLite
RUN mkdir -p /data/hermes/sessions
VOLUME ["/data/hermes"]

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["node", "apps/backend/src/index.js"]
