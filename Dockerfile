
FROM node:18-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
RUN update-ca-certificates
COPY ./package.json ./
RUN npm install
COPY ./src/ ./
ENTRYPOINT [ "node", "--no-deprecation", "/app/watcher.js" ]
