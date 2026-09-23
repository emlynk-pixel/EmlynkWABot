-- CreateTable
CREATE TABLE "admins" (
    "admin_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("admin_id")
);

-- CreateTable
CREATE TABLE "users" (
    "passport_id" TEXT NOT NULL,
    "unique_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "other_name" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "place_of_birth" TEXT,
    "passport_expiry_date" TIMESTAMP(3),
    "picture" TEXT,
    "whatsapp_number" TEXT,
    "contact_number" TEXT,
    "address" TEXT,
    "job" TEXT,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("passport_id")
);

-- CreateTable
CREATE TABLE "documents" (
    "document_id" TEXT NOT NULL,
    "passport_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_filename" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "file_size" BIGINT,
    "received_date" TIMESTAMP(3) NOT NULL,
    "processing_status" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "ocr_confidence" DECIMAL(65,30),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "temporary_data" (
    "temporary_id" TEXT NOT NULL,
    "passport_id" TEXT NOT NULL,
    "unique_id" TEXT NOT NULL,
    "whatsapp_number" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "temporary_storage_path" TEXT NOT NULL,
    "processing_status" TEXT NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_data_pkey" PRIMARY KEY ("temporary_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_unique_id_key" ON "users"("unique_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "users"("passport_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temporary_data" ADD CONSTRAINT "temporary_data_passport_id_fkey" FOREIGN KEY ("passport_id") REFERENCES "users"("passport_id") ON DELETE SET NULL ON UPDATE CASCADE;
