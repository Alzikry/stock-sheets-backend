// prisma.config.ts
// Prisma 7 memindahkan konfigurasi koneksi database ke file ini,
// terpisah dari schema.prisma

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
