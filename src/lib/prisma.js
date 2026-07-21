// src/lib/prisma.js
// Singleton Prisma Client - supaya tidak buka banyak koneksi database
// saat nodemon reload berkali-kali di development
//
// CATATAN: Prisma 7 mewajibkan pakai "driver adapter" untuk PostgreSQL,
// tidak bisa lagi new PrismaClient() polos seperti versi sebelumnya.

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const globalForPrisma = global;

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = globalForPrisma.prisma || new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;