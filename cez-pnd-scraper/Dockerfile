FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
