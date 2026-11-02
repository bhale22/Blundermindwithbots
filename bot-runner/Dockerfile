# The bot runner (bot-runner/README.md) as a container, for Railway or any
# host that runs one. Built from the repo root; on Railway, set the service
# variable RAILWAY_DOCKERFILE_PATH=/bot-runner/Dockerfile. Only Playwright and
# the runner go in: the bots load the site from blundermindchess.com like any
# visitor, and get their bot files from BM_BOT_<NAME> variables.
FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
# The image carries the browsers for its own Playwright version. Should
# package-lock's ever move past it, the install fetches the matching one.
RUN npm ci --no-audit --no-fund && npx playwright install --only-shell chromium
COPY bot-runner/runner.mjs bot-runner/
# Browser profiles keep Maia's 44 MB download. A volume mounted at /data keeps
# them across deploys; without one, every deploy starts them fresh.
ENV BM_PROFILES_DIR=/data/profiles
CMD ["node", "bot-runner/runner.mjs"]
