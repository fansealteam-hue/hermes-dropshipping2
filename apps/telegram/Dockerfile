FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/telegram/package.json apps/telegram/
RUN npm install --workspace=@hermes/telegram --omit=dev
COPY apps/telegram/src apps/telegram/src
CMD ["node", "apps/telegram/src/bot.js"]
