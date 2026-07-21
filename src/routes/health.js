// src/routes/health.js
// Endpoint sederhana untuk memastikan server & database hidup

const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // Bungkus require prisma di dalam try-catch juga,
    // supaya kalau instansiasi Prisma Client gagal, error-nya tertangkap
    const prisma = require('../lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      server: 'running',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('DETAIL ERROR LENGKAP:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    res.status(500).json({
      status: 'error',
      server: 'running',
      database: 'disconnected',
      error: err.message,
      errorName: err.name,
      errorStack: err.stack,
    });
  }
});

module.exports = router;