import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const admin = await prisma.admin.upsert({
    where: { email: "admin@emlynk.com" },
    update: {},
    create: {
      adminId: "ADM001",
      name: "System Admin",
      email: "admin@emlynk.com",
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  const user = await prisma.user.upsert({
    where: { passportId: "P1234567" },
    update: {},
    create: {
      passportId: "P1234567",
      uniqueId: "0001",
      firstName: "Test",
      otherName: "User",
      whatsappNumber: "94770000000",
      contactNumber: "94770000000",
      job: "Technician",
    },
  });

  const document = await prisma.document.upsert({
    where: { documentId: "DOC001" },
    update: {},
    create: {
      documentId: "DOC001",
      passportId: user.passportId,
      documentType: "PASSPORT",
      originalFilename: "passport-original.pdf",
      storedFilename: "passport.pdf",
      storagePath: "clients/P1234567/passport/passport.pdf",
      mimeType: "application/pdf",
      receivedDate: new Date(),
      processingStatus: "PROCESSED",
      verificationStatus: "VERIFIED",
      ocrConfidence: 0.98,
    },
  });

  console.log("Seed completed");
  console.log({ admin, user, document });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });