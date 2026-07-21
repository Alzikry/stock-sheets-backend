FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm install

RUN npx prisma generate

COPY . .

EXPOSE 4000

CMD mkdir -p credentials && echo "$GOOGLE_CREDENTIALS_JSON" > credentials/service-account-key.json && node src/index.js
