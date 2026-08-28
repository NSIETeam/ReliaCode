FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
COPY --chown=nonroot:nonroot package.json ./
COPY --chown=nonroot:nonroot src ./src
COPY --chown=nonroot:nonroot migrations ./migrations
USER nonroot
EXPOSE 4180
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["src/server.mjs"]
