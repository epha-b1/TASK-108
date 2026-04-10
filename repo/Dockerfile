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
# - openjdk17-jre-headless: required by the PMML model adapter, which spawns
#   `/usr/lib/jvm/java-17-openjdk/bin/java -jar <model.jar>` (allowlist in
#   src/services/model.service.ts is `/usr/bin/java`; the alpine package
#   installs that symlink under /usr/bin/java).
# - python3: required by the ONNX model adapter, which spawns
#   `/usr/bin/python3 scripts/onnx_runner.py <model.onnx>`.
# - py3-pip: lets the runner script `import onnxruntime` if the operator
#   later installs the wheel; we install pip but not the wheel itself, so
#   inference falls back to the deterministic mock until an operator
#   explicitly opts into a real runtime, keeping the image small.
#
# Java + Python are mandatory because `MODEL_ADAPTER_MODE` defaults to
# `process` whenever NODE_ENV=production. Without them the model adapter
# would crash on the very first inference call in the production image
# (audit issue 2).
RUN apk add --no-cache \
      mariadb mariadb-client \
      openssl bash tini \
      openjdk17-jre-headless \
      python3 py3-pip \
 && ln -sf /usr/lib/jvm/default-jvm/bin/java /usr/bin/java
# The Alpine OpenJDK package installs java under /usr/lib/jvm/default-jvm/
# rather than /usr/bin/java. The model adapter allowlist (model.service.ts:
# ALLOWED_EXECUTABLES) expects `/usr/bin/java` exactly — strict equality, no
# `startsWith` shortcut — so we materialise the symlink at build time. This
# preserves the tight allowlist while still working on Alpine.

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json jest.config.js ./
COPY prisma/ ./prisma/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY unit_tests/ ./unit_tests/
COPY API_tests/ ./API_tests/
COPY docker/ ./docker/
# Note: the canonical OpenAPI source `docs/api-spec.md` lives at the project
# root (one level above repo/), intentionally outside this build context. The
# `unit_tests/contract_sync.spec.ts` test resolves it via a relative path
# from the repo and is therefore meant to be executed from a checkout that
# includes the project-root `docs/`, not from inside the built image.

RUN npm run build \
 && mkdir -p dist/models \
 && ln -s /app/src/models/prisma dist/models/prisma \
 && chmod +x ./docker/entrypoint.sh

# Persist the local database between container runs by mounting /var/lib/mysql
VOLUME ["/var/lib/mysql"]

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/server.js"]
