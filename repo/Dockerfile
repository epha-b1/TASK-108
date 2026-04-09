# TripForge — single-container deployable image.
#
# Bundles the Node.js API and a local MariaDB instance in one image, so the
# acceptance deployment is literally `docker run`. The entrypoint boots
# mariadbd in the background, waits for it to come up, runs prisma migrations,
# then execs the API server. The compose file at docker-compose.yml is for
# development and runs API + MySQL as separate services; the single-container
# image at this Dockerfile is the formal acceptance artifact.

FROM node:20-alpine

# - mariadb / mariadb-client: bundled database
# - openssl: required by Prisma engines
# - bash: entrypoint script
# - tini: small init so PID 1 reaps zombies (mariadbd is started in background)
RUN apk add --no-cache mariadb mariadb-client openssl bash tini

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json jest.config.js ./
COPY prisma/ ./prisma/
COPY src/ ./src/
COPY unit_tests/ ./unit_tests/
COPY API_tests/ ./API_tests/
COPY docker/ ./docker/

RUN npm run build \
 && mkdir -p dist/models \
 && ln -s /app/src/models/prisma dist/models/prisma \
 && chmod +x ./docker/entrypoint.sh

# Persist the local database between container runs by mounting /var/lib/mysql
VOLUME ["/var/lib/mysql"]

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/server.js"]
