FROM node:18-slim

# Install OpenSSL (required by Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Railway sets PORT automatically; expose default just in case
EXPOSE 3000

# Push schema and start the server
CMD ["sh", "-c", "echo '=== exact filename ===' && ls -la /app/src/middleware/ | cat -A && echo '=== file head ===' && head -5 /app/src/middleware/auth.js && echo '=== node resolve test ===' && cd /app/src && node -e \"try { const m = require('./middleware/auth'); console.log('LOADED:', typeof m); } catch (e) { console.log('FAILED:', e.code, e.message); }\" && echo '=== END ==='"]
