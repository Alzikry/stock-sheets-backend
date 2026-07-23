/*
  Warnings:

  - You are about to drop the column `finalCountedKoli` on the `StockOpnameSession` table. All the data in the column will be lost.
  - You are about to drop the column `periodLabel` on the `StockOpnameSession` table. All the data in the column will be lost.
  - You are about to drop the column `productId` on the `StockOpnameSession` table. All the data in the column will be lost.
  - You are about to drop the column `selisihKoli` on the `StockOpnameSession` table. All the data in the column will be lost.
  - You are about to drop the column `systemKoli` on the `StockOpnameSession` table. All the data in the column will be lost.
  - You are about to drop the `StockOpnamePartial` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `name` to the `StockOpnameSession` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "StockOpnamePartial" DROP CONSTRAINT "StockOpnamePartial_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "StockOpnameSession" DROP CONSTRAINT "StockOpnameSession_productId_fkey";

-- AlterTable
ALTER TABLE "StockOpnameSession" DROP COLUMN "finalCountedKoli",
DROP COLUMN "periodLabel",
DROP COLUMN "productId",
DROP COLUMN "selisihKoli",
DROP COLUMN "systemKoli",
ADD COLUMN     "name" TEXT NOT NULL;

-- DropTable
DROP TABLE "StockOpnamePartial";

-- CreateTable
CREATE TABLE "StockOpnameItem" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "systemKoli" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockOpnameItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockOpnameEntry" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "countedKoli" DECIMAL(65,30) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockOpnameEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockOpnameItem_sessionId_productId_key" ON "StockOpnameItem"("sessionId", "productId");

-- AddForeignKey
ALTER TABLE "StockOpnameItem" ADD CONSTRAINT "StockOpnameItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StockOpnameSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockOpnameItem" ADD CONSTRAINT "StockOpnameItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockOpnameEntry" ADD CONSTRAINT "StockOpnameEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StockOpnameItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
