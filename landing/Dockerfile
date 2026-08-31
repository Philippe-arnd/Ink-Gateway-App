FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG PUBLIC_APP_URL=https://ink-gateway.philapps.com/app
ENV PUBLIC_APP_URL=$PUBLIC_APP_URL
RUN npm run build

FROM nginx:1-alpine
COPY --from=build /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
