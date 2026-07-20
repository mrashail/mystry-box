-- CreateTable
CREATE TABLE "MysteryCustomerHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mysteryBoxId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "productHandle" TEXT,
    "productType" TEXT,
    "vendor" TEXT,
    "tags" JSONB NOT NULL,
    "collectionIds" JSONB NOT NULL,
    "variantId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL,
    "inventoryQuantity" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_CatalogVariant" ("available", "collectionIds", "createdAt", "id", "imageUrl", "inventoryItemId", "inventoryQuantity", "price", "productHandle", "productId", "productTitle", "productType", "shop", "sku", "tags", "updatedAt", "variantId", "variantTitle", "vendor") SELECT "available", "collectionIds", "createdAt", "id", "imageUrl", "inventoryItemId", "inventoryQuantity", "price", "productHandle", "productId", "productTitle", "productType", "shop", "sku", "tags", "updatedAt", "variantId", "variantTitle", "vendor" FROM "CatalogVariant";
DROP TABLE "CatalogVariant";
ALTER TABLE "new_CatalogVariant" RENAME TO "CatalogVariant";
CREATE INDEX "CatalogVariant_shop_productId_idx" ON "CatalogVariant"("shop", "productId");
CREATE INDEX "CatalogVariant_shop_sku_idx" ON "CatalogVariant"("shop", "sku");
CREATE INDEX "CatalogVariant_shop_inventoryItemId_idx" ON "CatalogVariant"("shop", "inventoryItemId");
CREATE UNIQUE INDEX "CatalogVariant_shop_variantId_key" ON "CatalogVariant"("shop", "variantId");
CREATE TABLE "new_ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "storefrontEnabled" BOOLEAN NOT NULL DEFAULT true,
    "giftMessageEnabled" BOOLEAN NOT NULL DEFAULT true,
    "giftMessage" TEXT NOT NULL DEFAULT '🎁 A free gift has been added to your cart.',
    "mysteryMessage" TEXT NOT NULL DEFAULT '🎉 Your mystery item has been selected.',
    "conflictStrategy" TEXT NOT NULL DEFAULT 'PRIORITY',
    "maxAutomaticAdds" INTEGER NOT NULL DEFAULT 10,
    "automaticDiscountId" TEXT,
    "cartTransformId" TEXT,
    "promotionSecret" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("automaticDiscountId", "cartTransformId", "conflictStrategy", "createdAt", "giftMessage", "giftMessageEnabled", "id", "maxAutomaticAdds", "mysteryMessage", "promotionSecret", "shop", "storefrontEnabled", "updatedAt") SELECT "automaticDiscountId", "cartTransformId", "conflictStrategy", "createdAt", "giftMessage", "giftMessageEnabled", "id", "maxAutomaticAdds", "mysteryMessage", "promotionSecret", "shop", "storefrontEnabled", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MysteryCustomerHistory_shop_customerId_mysteryBoxId_idx" ON "MysteryCustomerHistory"("shop", "customerId", "mysteryBoxId");

-- CreateIndex
CREATE UNIQUE INDEX "MysteryCustomerHistory_shop_customerId_mysteryBoxId_variantId_orderId_key" ON "MysteryCustomerHistory"("shop", "customerId", "mysteryBoxId", "variantId", "orderId");
