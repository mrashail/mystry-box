CREATE TABLE "ShopSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "storefrontEnabled" BOOLEAN NOT NULL DEFAULT true,
  "giftMessageEnabled" BOOLEAN NOT NULL DEFAULT true,
  "giftMessage" TEXT NOT NULL DEFAULT '🎁 A free gift has been added to your cart.',
  "mysteryMessage" TEXT NOT NULL DEFAULT '🎉 Your mystery item has been selected.',
  "conflictStrategy" TEXT NOT NULL DEFAULT 'PRIORITY',
  "maxAutomaticAdds" INTEGER NOT NULL DEFAULT 10,
  "automaticDiscountId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

CREATE TABLE "GiftRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "matchMode" TEXT NOT NULL DEFAULT 'ALL',
  "conditions" JSONB NOT NULL,
  "gifts" JSONB NOT NULL,
  "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
  "maxGifts" INTEGER NOT NULL DEFAULT 1,
  "stackable" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" DATETIME,
  "endsAt" DATETIME,
  "restrictions" JSONB NOT NULL,
  "notification" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "GiftRule_shop_enabled_priority_idx" ON "GiftRule"("shop", "enabled", "priority");

CREATE TABLE "MysteryBox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "parentProductId" TEXT NOT NULL,
  "parentProductTitle" TEXT NOT NULL,
  "parentVariantId" TEXT,
  "parentVariantTitle" TEXT,
  "selectionMethod" TEXT NOT NULL DEFAULT 'RANDOM',
  "inventoryBehavior" TEXT NOT NULL DEFAULT 'IN_STOCK_ONLY',
  "selectionCount" INTEGER NOT NULL DEFAULT 1,
  "allowDuplicateChoices" BOOLEAN NOT NULL DEFAULT false,
  "matchingRules" JSONB NOT NULL,
  "priceTiers" JSONB NOT NULL,
  "bogo" JSONB NOT NULL,
  "restrictions" JSONB NOT NULL,
  "startsAt" DATETIME,
  "endsAt" DATETIME,
  "cursor" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "MysteryBox_shop_enabled_priority_idx" ON "MysteryBox"("shop", "enabled", "priority");
CREATE INDEX "MysteryBox_shop_parentProductId_idx" ON "MysteryBox"("shop", "parentProductId");
CREATE INDEX "MysteryBox_shop_parentVariantId_idx" ON "MysteryBox"("shop", "parentVariantId");

CREATE TABLE "MysteryBoxChild" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mysteryBoxId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productTitle" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "variantTitle" TEXT NOT NULL,
  "sku" TEXT,
  "imageUrl" TEXT,
  "inventoryQuantity" INTEGER,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "weight" INTEGER NOT NULL DEFAULT 1,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MysteryBoxChild_mysteryBoxId_fkey" FOREIGN KEY ("mysteryBoxId") REFERENCES "MysteryBox"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MysteryBoxChild_mysteryBoxId_variantId_key" ON "MysteryBoxChild"("mysteryBoxId", "variantId");
CREATE INDEX "MysteryBoxChild_mysteryBoxId_position_idx" ON "MysteryBoxChild"("mysteryBoxId", "position");

CREATE TABLE "CatalogVariant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productTitle" TEXT NOT NULL,
  "productHandle" TEXT,
  "productType" TEXT,
  "vendor" TEXT,
  "tags" JSONB NOT NULL,
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
CREATE UNIQUE INDEX "CatalogVariant_shop_variantId_key" ON "CatalogVariant"("shop", "variantId");
CREATE INDEX "CatalogVariant_shop_productId_idx" ON "CatalogVariant"("shop", "productId");
CREATE INDEX "CatalogVariant_shop_sku_idx" ON "CatalogVariant"("shop", "sku");
CREATE INDEX "CatalogVariant_shop_inventoryItemId_idx" ON "CatalogVariant"("shop", "inventoryItemId");

CREATE TABLE "PromotionUsage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "promotionType" TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "customerId" TEXT,
  "orderId" TEXT,
  "cartToken" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "metadata" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PromotionUsage_shop_promotionType_promotionId_idx" ON "PromotionUsage"("shop", "promotionType", "promotionId");
CREATE INDEX "PromotionUsage_shop_customerId_idx" ON "PromotionUsage"("shop", "customerId");
CREATE INDEX "PromotionUsage_shop_orderId_idx" ON "PromotionUsage"("shop", "orderId");
CREATE UNIQUE INDEX "PromotionUsage_shop_promotionType_promotionId_orderId_key" ON "PromotionUsage"("shop", "promotionType", "promotionId", "orderId");

CREATE TABLE "MysterySelection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "mysteryBoxId" TEXT NOT NULL,
  "cartToken" TEXT NOT NULL,
  "parentLineKey" TEXT NOT NULL,
  "selectedVariants" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CART',
  "orderId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "MysterySelection_shop_cartToken_parentLineKey_mysteryBoxId_key" ON "MysterySelection"("shop", "cartToken", "parentLineKey", "mysteryBoxId");
CREATE INDEX "MysterySelection_shop_orderId_idx" ON "MysterySelection"("shop", "orderId");
