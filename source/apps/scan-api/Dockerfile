FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/scan-api/package.json ./apps/scan-api/package.json
COPY apps/scan-web/package.json ./apps/scan-web/package.json
RUN npm ci --omit=dev --workspace @reliacode/scan-api

# Distroless publishes rebuilt nonroot images as Debian security fixes land.
# The production workflow forces a fresh pull and records the resolved digest
# in BuildKit provenance while the resulting application image is SHA-tagged.
FROM gcr.io/distroless/nodejs24-debian13:nonroot
ARG APP_VERSION=development
ARG GIT_SHA=unknown
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --chown=nonroot:nonroot --from=dependencies /app/node_modules ./node_modules
COPY --chown=nonroot:nonroot --from=dependencies /app/apps/scan-api/node_modules ./node_modules
COPY --chown=nonroot:nonroot apps/scan-api/package.json ./
COPY --chown=nonroot:nonroot apps/scan-api/src ./src
COPY --chown=nonroot:nonroot apps/scan-api/migrations ./migrations
USER nonroot
EXPOSE 4180
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["src/bootstrap.mjs"]
