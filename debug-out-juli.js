require('dotenv').config();
const { readSummarySheet, isMonthlyRecapRow } = require('./src/services/sheetsParser');

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const { products } = await readSummarySheet(spreadsheetId);

  const suspects = products.filter((p) => p.code.toLowerCase().includes('juli') || p.code.toLowerCase().includes('out'));

  console.log(`Ditemukan ${suspects.length} baris yang mengandung "juli" atau "out":\n`);

  for (const p of suspects) {
    console.log('code:', JSON.stringify(p.code));
    console.log('  panjang string:', p.code.length);
    console.log('  isMonthlyRecapRow:', isMonthlyRecapRow(p.code));
    console.log('  char codes:', Array.from(p.code).map((c) => c.charCodeAt(0)).join(','));
    console.log('');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
