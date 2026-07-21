// src/routes/health.js
// Endpoint sederhana untuk memastikan server & database hidup

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

router.get('/', async (req, res) => {
  try {
    // Test koneksi database dengan query super ringan
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      server: 'running',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Log detail error lengkap untuk debugging (sementara)
    console.error('DETAIL ERROR LENGKAP:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    res.status(500).json({
      status: 'error',
      server: 'running',
      database: 'disconnected',
      error: err.message,
    });
  }
});

module.exports = router;