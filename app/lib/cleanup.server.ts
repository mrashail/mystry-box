import prisma from "../db.server";

export async function deleteShopData(shop: string) {
  const boxes = await prisma.mysteryBox.findMany({ where: { shop }, select: { id: true } });
  await prisma.$transaction([
    prisma.mysteryBoxChild.deleteMany({ where: { mysteryBoxId: { in: boxes.map((box) => box.id) } } }),
    prisma.mysteryBox.deleteMany({ where: { shop } }),
    prisma.giftRule.deleteMany({ where: { shop } }),
    prisma.catalogVariant.deleteMany({ where: { shop } }),
    prisma.promotionUsage.deleteMany({ where: { shop } }),
    prisma.mysterySelection.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
