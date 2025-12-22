
FROM alpine:3.23.2 AS nodejs

# Install nodejs
RUN addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node \
    && apk add --no-cache nodejs

FROM nodejs AS nodejs-and-npm

# Install npm & yarn
RUN apk add --no-cache npm yarn

FROM nodejs-and-npm AS development

WORKDIR /usr/src/app

COPY --chown=node:node backend/package.json ./
COPY --chown=node:node yarn.lock ./

RUN yarn install --frozen-lockfile --immutable --non-interactive --prefer-offline

USER node

FROM nodejs-and-npm AS build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/ .

COPY --chown=node:node backend .

RUN yarn run build

USER node

FROM nodejs-and-npm AS production-deps

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV NO_COLOR=true

COPY --chown=node:node backend/package.json ./
COPY --chown=node:node yarn.lock ./

RUN yarn install --frozen-lockfile --immutable --non-interactive --prefer-offline --production && yarn cache clean --force

USER node

FROM nodejs AS production

# Copy the bundled code from the build stage to the production image
COPY --chown=node:node --from=production-deps /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

CMD [ "node", "dist/src/index.js" ]

EXPOSE 80