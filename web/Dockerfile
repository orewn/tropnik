ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG SITE_ORIGIN
ARG TROPA_PUBLIC_INDEXING=false
ENV NEXT_PUBLIC_SITE_URL=${SITE_ORIGIN} TROPA_PUBLIC_INDEXING=${TROPA_PUBLIC_INDEXING}
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN test -n "$NEXT_PUBLIC_SITE_URL" && TROPA_STANDALONE=true pnpm run build:next

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
