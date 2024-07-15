FROM node:18.20.4-alpine As development

WORKDIR /usr/src/app

COPY --chown=node:node backend/package.json ./
COPY --chown=node:node yarn.lock ./

RUN yarn install --frozen-lockfile --immutable --non-interactive --prefer-offline

USER node

FROM node:18.20.4-alpine As build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/ .

COPY --chown=node:node backend .

RUN yarn run build

USER node

FROM node:18.20.4-alpine As productionDeps

WORKDIR /usr/src/app

ENV NODE_ENV production
ENV NO_COLOR true

COPY --chown=node:node backend/package.json ./
COPY --chown=node:node yarn.lock ./

RUN yarn install --frozen-lockfile --immutable --non-interactive --prefer-offline --production && yarn cache clean --force

USER node

FROM node:18.20.4-alpine As production

# Copy the bundled code from the build stage to the production image
COPY --chown=node:node --from=productionDeps /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

CMD [ "node", "dist/src/index.js" ]

EXPOSE 80