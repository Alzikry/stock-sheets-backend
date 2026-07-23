-- CreateTable
CREATE TABLE "StockOpnameSession" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "systemKoli" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "finalCountedKoli" DECIMAL(65,30),
    "selisihKoli" DECIMAL(65,30),
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockOpnameSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockOpnamePartial" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "countedKoli" DECIMAL(65,30) NOT NULL,
    "note" TEXT,
    "countedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockOpnamePartial_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StockOpnameSession" ADD CONSTRAINT "StockOpnameSession_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockOpnamePartial" ADD CONSTRAINT "StockOpnamePartial_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StockOpnameSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
