FROM node:18-alpine As development

WORKDIR /usr/src/app

COPY --chown=node:node package.json ./
COPY --chown=node:node package-lock.json ./

RUN npm ci

USER node

FROM node:18-alpine As build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/ .

COPY --chown=node:node . .

RUN npm run build

ENV NODE_ENV production
ENV NO_COLOR true

RUN npm prune --omit=dev && npm cache clean --force

USER node

FROM node:18-alpine As production

# Copy the bundled code from the build stage to the production image
COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

CMD [ "node", "dist/index.js" ]

EXPOSE 80