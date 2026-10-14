FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY juno-expo/package.json juno-expo/package-lock.json ./
COPY juno-expo/patches ./patches
RUN npm ci --legacy-peer-deps
COPY juno-expo .
ARG EXPO_PUBLIC_API_URL
ARG EXPO_PUBLIC_APP_URL
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL EXPO_PUBLIC_APP_URL=$EXPO_PUBLIC_APP_URL CI=1
RUN npm run export:web
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
