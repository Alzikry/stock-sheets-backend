// src/index.js
// Entry point server Express

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const healthRoute = require('./routes/health');
const syncRoute = require('./routes/sync');
const productsRoute = require('./routes/products');
const opnameRoute = require('./routes/opname');
const reportsRoute = require('./routes/reports');
const telegramRoute = require('./routes/telegram');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoute);
app.use('/api/sync', syncRoute);
app.use('/api/products', productsRoute);
app.use('/api/opname', opnameRoute);
app.use('/api/reports', reportsRoute);
app.use('/api/telegram', telegramRoute);

app.get('/', (req, res) => {
  res.json({ message: 'Stock Sheets Viewer API is running' });
});

// Hanya jalankan server lokal kalau BUKAN di Vercel
// (Vercel jalankan app ini lewat serverless function, bukan app.listen)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`✅ Server berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;