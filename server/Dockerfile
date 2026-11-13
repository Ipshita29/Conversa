# Conversa API. Needs an always-on host (webhooks must be answered, pictures are processed in the background, files are kept on a persistent disk).
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Customer pictures and payment screenshots: mount a persistent volume here.
ENV PAYMENT_PROOF_DIR=/data/proofs
VOLUME ["/data"]
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-5000}/api/health || exit 1
USER node
CMD ["node", "server.js"]
