FROM node:22-alpine
WORKDIR /app
COPY apps/web/package.json ./
RUN npm install --production
COPY apps/web/src ./src
COPY apps/web/public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
