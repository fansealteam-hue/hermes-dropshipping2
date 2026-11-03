FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
COPY apps/backend/package.json apps/backend/
RUN npm install --workspace=@hermes/backend --omit=dev
COPY apps/backend/src apps/backend/src
EXPOSE 3001
CMD ["node", "apps/backend/src/index.js"]
