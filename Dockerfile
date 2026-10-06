FROM oven/bun:1.3.14-slim AS base
WORKDIR /workspace
COPY package.json bun.lock ./

FROM base AS build
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

FROM base AS dependencies
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.14-slim AS runtime
ENV NODE_ENV=production
EXPOSE 4410
WORKDIR /workspace
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /workspace/build ./build
RUN chmod +x build/bin/*.js && bun link
COPY server.ts ./server.ts
CMD ["bun", "server.ts"]
