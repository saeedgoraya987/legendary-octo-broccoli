# Dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
