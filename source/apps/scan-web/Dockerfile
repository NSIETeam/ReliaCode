FROM node:24-alpine
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0
USER node
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node *.html *.js *.mjs *.css *.svg ./
COPY --chown=node:node vendor ./vendor
EXPOSE 4173
CMD ["node", "server.mjs"]
