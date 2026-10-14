FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_ARC_NETWORK=testnet
RUN npm run build
ENV NODE_ENV=production JUNO_MEDIA_DIR=/data/media
COPY --chmod=755 docker/api-entrypoint.sh /usr/local/bin/api-entrypoint
ENTRYPOINT ["api-entrypoint"]
CMD ["sh", "-c", "exec npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
