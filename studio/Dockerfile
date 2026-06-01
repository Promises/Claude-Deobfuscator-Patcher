# Frontend — Next.js (standalone) served on :80, fronted by the global *.test nginx.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Browser-facing URL of the backend socket — baked in at build time
# (NEXT_PUBLIC_* is inlined during `next build`). Points at the backend's
# *.test hostname so the browser connects through the global nginx.
ARG NEXT_PUBLIC_STUDIO_WS=https://patcher-studio-api.test
ENV NEXT_PUBLIC_STUDIO_WS=$NEXT_PUBLIC_STUDIO_WS
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 80
CMD ["node", "server.js"]
