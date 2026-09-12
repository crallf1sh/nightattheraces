FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_FILE=/app/data/races.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node","server.js"]
