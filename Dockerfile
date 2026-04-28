FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app

ARG NEXT_PUBLIC_ENABLE_GAMMA=true
ARG NEXT_PUBLIC_POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
ARG NEXT_PUBLIC_POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=

ENV NEXT_PUBLIC_ENABLE_GAMMA=$NEXT_PUBLIC_ENABLE_GAMMA
ENV NEXT_PUBLIC_POLYMARKET_GAMMA_URL=$NEXT_PUBLIC_POLYMARKET_GAMMA_URL
ENV NEXT_PUBLIC_POLYMARKET_WS_URL=$NEXT_PUBLIC_POLYMARKET_WS_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=13000
ENV HOSTNAME=0.0.0.0
ENV POLYMARKET_CLOB_URL=https://clob.polymarket.com
ENV NEXT_PUBLIC_POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV CLERK_SECRET_KEY=

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 13000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:13000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
