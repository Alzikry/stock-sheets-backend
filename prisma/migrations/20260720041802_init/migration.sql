-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "pcsPerKoli" INTEGER NOT NULL,
    "kategori" TEXT,
    "rowOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSummary" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "stockHandKoli" DECIMAL(65,30) NOT NULL,
    "totalInKoli" DECIMAL(65,30) NOT NULL,
    "totalOutKoli" DECIMAL(65,30) NOT NULL,
    "totalReturKoli" DECIMAL(65,30) NOT NULL,
    "endStockKoli" DECIMAL(65,30) NOT NULL,
    "endStockPcs" DECIMAL(65,30) NOT NULL,
    "stockCountFinal" DECIMAL(65,30) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockDailyEntry" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "inKoli" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "outKoli" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockDailyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturDailyEntry" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "returKoli" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturDailyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "rowsSynced" INTEGER,
    "errorMessage" TEXT,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");

-- CreateIndex
CREATE UNIQUE INDEX "StockSummary_productId_periodLabel_key" ON "StockSummary"("productId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "StockDailyEntry_productId_date_key" ON "StockDailyEntry"("productId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ReturDailyEntry_productId_date_key" ON "ReturDailyEntry"("productId", "date");

-- AddForeignKey
ALTER TABLE "StockSummary" ADD CONSTRAINT "StockSummary_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDailyEntry" ADD CONSTRAINT "StockDailyEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturDailyEntry" ADD CONSTRAINT "ReturDailyEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
