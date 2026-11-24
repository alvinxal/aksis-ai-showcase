FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM docker.io/library/node:22-alpine AS web
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/index.html web/tsconfig.json web/vite.config.ts web/.env.production ./
COPY web/public ./public
COPY web/src ./src
RUN pnpm build

FROM docker.io/library/node:22-alpine
ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
