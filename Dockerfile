FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN sed -i 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g; s#http://security.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' /etc/apt/sources.list.d/debian.sources \
  && npm config set registry https://registry.npmmirror.com

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV BROWSER_PATH=/usr/bin/chromium

WORKDIR /app

RUN sed -i 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g; s#http://security.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' /etc/apt/sources.list.d/debian.sources \
  && npm config set registry https://registry.npmmirror.com

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY src/server/views ./dist/server/views

RUN mkdir -p /data/md-pdf/files /app/.md-pdf-server

EXPOSE 50001

CMD ["npm", "run", "start:server:docker"]
