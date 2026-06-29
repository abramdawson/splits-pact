FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=7228
ENV PACT_DB_PATH=/data/pact.sqlite
EXPOSE 7228

CMD ["node", "server.js"]

