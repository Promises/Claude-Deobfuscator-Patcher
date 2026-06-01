# Backend — Bun + Socket.IO, importing the tools-ts pipeline in-process.
# The patch-ref repo (tools-ts, tools/splitter.py, versionref, patches.d, studio)
# is bind-mounted at runtime, so this image only provides the runtime:
#   - bun      : runs the server + the TS pipeline
#   - python3  : the module splitter (tools/splitter.py)
#   - git      : the optional anchor:save → commit path
FROM oven/bun:1-alpine

RUN apk add --no-cache python3 git

WORKDIR /patch-ref/studio/server
ENV PORT=80
ENV STUDIO_PORT=80

EXPOSE 80
CMD ["bun", "run", "index.ts"]
