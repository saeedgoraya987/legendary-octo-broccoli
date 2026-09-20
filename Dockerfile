# Dockerfile
FROM node:20-slim

# Baileys depends on libsignal-node via a git URL (WhisperSystems/libsignal-node).
# node:20-slim has no git binary, so npm's spawn git fails with exit 254.
# Install git + ca-certificates + python3/make/g++ for any native module builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so the npm layer caches independent of source edits.
COPY package.json ./
# No package-lock.json in the repo → plain install. If you add a lockfile,
# switch this to `npm ci --omit=dev` for reproducible builds.
RUN npm install --omit=dev

COPY server.mjs ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
