# Build from the REPOSITORY ROOT so pnpm workspace packages resolve:
#   docker build -f apps/shopify-app/Dockerfile -t techladder-shopify .
FROM node:22-alpine

RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
ENV NODE_ENV=production

# Copy the whole workspace: apps/shopify-app depends on packages/core and
# packages/adapter-shopify via workspace:*.
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @techladder/core build \
 && pnpm --filter @techladder/adapter-shopify build \
 && pnpm --filter app exec prisma generate \
 && pnpm --filter app build

EXPOSE 3000
CMD ["pnpm", "--filter", "app", "start"]
