# Build from the REPOSITORY ROOT so pnpm workspace packages resolve:
#   docker build -f apps/shopify-app/Dockerfile -t techladder-shopify .
FROM node:22-alpine

RUN apk add --no-cache openssl && corepack enable
WORKDIR /app

# Copy the whole workspace: apps/shopify-app depends on packages/core and
# packages/adapter-shopify via workspace:*.
COPY . .

# NODE_ENV stays unset through install and build: the package `prepare` hooks
# (tsup) and the app `postinstall` (prisma generate) are dev-time tools.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter app build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "app", "start"]
