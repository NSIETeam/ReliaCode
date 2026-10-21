FROM gcr.io/distroless/nodejs24-debian13:nonroot
ARG APP_VERSION=development
ARG GIT_SHA=unknown
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA
USER nonroot
WORKDIR /app
COPY --chown=nonroot:nonroot package.json package-lock.json ./
COPY --chown=nonroot:nonroot *.html *.js *.mjs *.css *.svg ./
COPY --chown=nonroot:nonroot vendor ./vendor
EXPOSE 4173
CMD ["server.mjs"]
