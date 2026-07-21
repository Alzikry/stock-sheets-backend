// src/index.js
// Entry point server Express

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const healthRoute = require('./routes/health');
const syncRoute = require('./routes/sync');
const productsRoute = require('./routes/products');
const { startScheduler } = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoute);
app.use('/api/sync', syncRoute);
app.use('/api/products', productsRoute);

app.get('/', (req, res) => {
  res.json({ message: 'Stock Sheets Viewer API is running' });
});

app.listen(PORT, () => {
  console.log(`✅ Server berjalan di http://localhost:${PORT}`);
  startScheduler();
});