-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftRule" (
    "id" TEXT NOT NULL,
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
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "restrictions" JSONB NOT NULL,
    "notification" TEXT,
    "shopifyDiscountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysteryBox" (
    "id" TEXT NOT NULL,
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
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "boxProductId" TEXT,
    "boxVariantId" TEXT,
    "boxPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "boxImageUrl" TEXT,
    "shopifyDiscountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MysteryBox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysteryBoxChild" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MysteryBoxChild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "id" TEXT NOT NULL,
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
    "price" DECIMAL(65,30),
    "inventoryQuantity" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "promotionType" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "cartToken" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysterySelection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "mysteryBoxId" TEXT NOT NULL,
    "cartToken" TEXT NOT NULL,
    "parentLineKey" TEXT NOT NULL,
    "selectedVariants" JSONB NOT NULL,
    "selectionQuantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'CART',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MysterySelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MysteryCustomerHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mysteryBoxId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MysteryCustomerHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "GiftRule_shop_enabled_priority_idx" ON "GiftRule"("shop", "enabled", "priority");

-- CreateIndex
CREATE INDEX "MysteryBox_shop_enabled_priority_idx" ON "MysteryBox"("shop", "enabled", "priority");

-- CreateIndex
CREATE INDEX "MysteryBox_shop_parentProductId_idx" ON "MysteryBox"("shop", "parentProductId");

-- CreateIndex
CREATE INDEX "MysteryBox_shop_parentVariantId_idx" ON "MysteryBox"("shop", "parentVariantId");

-- CreateIndex
CREATE INDEX "MysteryBoxChild_mysteryBoxId_position_idx" ON "MysteryBoxChild"("mysteryBoxId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MysteryBoxChild_mysteryBoxId_variantId_key" ON "MysteryBoxChild"("mysteryBoxId", "variantId");

-- CreateIndex
CREATE INDEX "CatalogVariant_shop_productId_idx" ON "CatalogVariant"("shop", "productId");

-- CreateIndex
CREATE INDEX "CatalogVariant_shop_sku_idx" ON "CatalogVariant"("shop", "sku");

-- CreateIndex
CREATE INDEX "CatalogVariant_shop_inventoryItemId_idx" ON "CatalogVariant"("shop", "inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVariant_shop_variantId_key" ON "CatalogVariant"("shop", "variantId");

-- CreateIndex
CREATE INDEX "PromotionUsage_shop_promotionType_promotionId_idx" ON "PromotionUsage"("shop", "promotionType", "promotionId");

-- CreateIndex
CREATE INDEX "PromotionUsage_shop_customerId_idx" ON "PromotionUsage"("shop", "customerId");

-- CreateIndex
CREATE INDEX "PromotionUsage_shop_orderId_idx" ON "PromotionUsage"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionUsage_shop_promotionType_promotionId_orderId_key" ON "PromotionUsage"("shop", "promotionType", "promotionId", "orderId");

-- CreateIndex
CREATE INDEX "MysterySelection_shop_orderId_idx" ON "MysterySelection"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MysterySelection_shop_cartToken_parentLineKey_mysteryBoxId_key" ON "MysterySelection"("shop", "cartToken", "parentLineKey", "mysteryBoxId");

-- CreateIndex
CREATE INDEX "MysteryCustomerHistory_shop_customerId_mysteryBoxId_idx" ON "MysteryCustomerHistory"("shop", "customerId", "mysteryBoxId");

-- CreateIndex
CREATE UNIQUE INDEX "MysteryCustomerHistory_shop_customerId_mysteryBoxId_variant_key" ON "MysteryCustomerHistory"("shop", "customerId", "mysteryBoxId", "variantId", "orderId");

-- AddForeignKey
ALTER TABLE "MysteryBoxChild" ADD CONSTRAINT "MysteryBoxChild_mysteryBoxId_fkey" FOREIGN KEY ("mysteryBoxId") REFERENCES "MysteryBox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

