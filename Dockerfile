# Build once, then deploy this image to any internal server with Docker.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_FILE=/app/data/races.sqlite

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
