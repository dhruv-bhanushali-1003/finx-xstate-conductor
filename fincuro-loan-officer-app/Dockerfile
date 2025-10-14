# Stage 1: Install dependencies & build
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy everything else
COPY . .

# Build Next.js app (this also processes Tailwind via PostCSS)
RUN npm run build

# Stage 2: Production image
FROM node:18-alpine

WORKDIR /app

# Copy built files & dependencies from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js 2>/dev/null || true

EXPOSE 9001

ENV PORT=9001
ENV HOSTNAME=0.0.0.0

# Start in production
CMD ["npm", "start"]
