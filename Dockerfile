# Widget backend container for staging (Cloud Run). Runs the Fastify service via tsx (no build step).
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true PORT=8787
RUN corepack enable
WORKDIR /app

# Install deps first (better layer caching). Needs all workspace manifests + the lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

EXPOSE 8787
# Cloud Run sets $PORT; the server reads it. Model adapter is chosen at runtime (Vertex if
# GOOGLE_CLOUD_PROJECT is set via the service's env/SA, else the mock).
CMD ["pnpm", "backend"]
