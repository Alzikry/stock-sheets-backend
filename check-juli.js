require('dotenv').config();
const prisma = require('./src/lib/prisma');

async function main() {
  const results = await prisma.product.findMany({
    where: { code: { contains: 'Juli', mode: 'insensitive' } },
  });
  console.log(JSON.stringify(results, null, 2));
  await prisma.$disconnect();
}

main();
