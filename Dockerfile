FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# PROCESS=web | worker  (run one service of each)
CMD ["sh", "-c", "if [ \"$PROCESS\" = worker ]; then node dist/src/worker.js; else node dist/src/server.js; fi"]
