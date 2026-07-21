// src/services/scheduler.js
//
// Menjadwalkan sync otomatis 2x sehari pakai node-cron.
// Dipanggil sekali saat server pertama kali start (lihat src/index.js).

const cron = require('node-cron');
const { syncFromSheets } = require('./syncService');

/**
 * Jadwal cron pakai format: "menit jam * * *"
 * Contoh: "0 10 * * *" = setiap hari jam 10:00
 *         "0 15 * * *" = setiap hari jam 15:00
 *
 * Timezone mengikuti timezone server (WIB kalau server jalan di Indonesia).
 * Kalau nanti di-deploy ke cloud, cek dulu timezone servernya.
 */
const SCHEDULE_TIMES = [
  { cronExpr: '0 10 * * *', label: '10:00' },
  { cronExpr: '0 15 * * *', label: '15:00' },
];

function startScheduler() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  SCHEDULE_TIMES.forEach(({ cronExpr, label }) => {
    cron.schedule(cronExpr, async () => {
      console.log(`\n⏰ [Scheduled Sync] Memulai sync terjadwal (${label})...`);

      const now = new Date();
      try {
        const result = await syncFromSheets({
          spreadsheetId,
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          triggeredBy: 'schedule',
        });
        console.log(`✅ [Scheduled Sync] Selesai. ${result.rowsSynced} produk disinkronkan.`);
      } catch (err) {
        console.error(`❌ [Scheduled Sync] Gagal:`, err.message);
      }
    });

    console.log(`📅 Sync terjadwal didaftarkan: setiap hari jam ${label}`);
  });
}

module.exports = { startScheduler };