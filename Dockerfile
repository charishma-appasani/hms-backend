# Build stage
FROM node:22-alpine AS builder

# Install necessary certificates and tools
RUN apk add --no-cache ca-certificates postgresql-client wget

# Create directory for certificates
RUN mkdir -p /etc/ssl/certs/

# Download the latest RDS certificate bundle and verify it exists
RUN wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -O /etc/ssl/certs/rds-ca.pem \
    && chmod 644 /etc/ssl/certs/rds-ca.pem \
    && ls -la /etc/ssl/certs/rds-ca.pem

WORKDIR /app

# Copy package files
COPY package*.json ./

# Prisma schema + config AND tsconfig must exist before `npm ci`, because the `postinstall`
# script runs `prisma generate`. Prisma reads tsconfig.json to decide import specifiers — without
# it, the generated client imports `./x.ts` (not `./x.js`) and the built app fails at runtime
# with "Cannot find module './internal/class.ts'".
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig*.json ./

# Install dependencies (triggers postinstall → prisma generate → generated/prisma)
RUN npm ci

# Copy source code
COPY . .
RUN rm -rf infrastructure/

# Build the application
RUN npm run build

# Remove development dependencies
RUN npm prune --production


# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install necessary certificates and tools in production stage
RUN apk add --no-cache ca-certificates postgresql-client wget \
    && mkdir -p /etc/ssl/certs/ \
    && wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -O /etc/ssl/certs/rds-ca.pem \
    && chmod 644 /etc/ssl/certs/rds-ca.pem

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
# The Prisma client is generated outside node_modules (generator output: ../generated/prisma)
# and is imported at runtime as generated/prisma/client — it must ship in the runtime image.
COPY --from=builder /app/generated ./generated

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Verify the certificate exists
RUN ls && ls -la /etc/ssl/certs/rds-ca.pem || echo "Certificate not found"

# Expose the port the app runs on
EXPOSE 3000

# Set NODE_ENV
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "dist/src/main"]
