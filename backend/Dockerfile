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
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node src/index.js"]

