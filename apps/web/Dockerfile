FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
RUN npm install --workspace=@hermes/web --omit=dev
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/src/server.js"]
