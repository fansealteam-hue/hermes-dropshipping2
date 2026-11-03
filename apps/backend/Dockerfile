FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY apps/backend/package.json ./
RUN npm install --production
COPY apps/backend/src ./src
EXPOSE 3001
CMD ["node", "src/index.js"]
