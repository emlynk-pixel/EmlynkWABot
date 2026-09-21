# WhatsApp Document Processing Automation
## Development Progress Documentation

**Project:** WhatsApp Document Processing Automation  
**Current Stage:** Initial Backend and Database Setup  
**Purpose:** Record each completed development process, verification step, and Git checkpoint.

---

## 1. Project Initialization

### Objective
Create a clean Node.js project repository for the WhatsApp Document Processing Automation system.

### Actions Completed
- Created the project folder.
- Initialized a Node.js project.
- Initialized Git.
- Added a `.gitignore`.
- Added an initial `README.md`.
- Verified the Git working tree.

### Commands Used

```bash
npm init -y
git init
git status
```

### Git Ignore
The project ignores files and folders that should not be committed, including:

```gitignore
node_modules/
.env
.env.*
!.env.example
logs/
*.log
.DS_Store
```

### Verification
The repository was verified using:

```bash
git status
```

Expected result after committing:

```text
nothing to commit, working tree clean
```

---

## 2. PostgreSQL Setup with Docker

### Objective
Run PostgreSQL locally in a consistent Docker environment.

### Docker Compose Configuration
A `docker-compose.yml` file was created with:

- PostgreSQL 16
- Database name: `emlynk_docs`
- Database user: `emlynk_user`
- PostgreSQL port: `5432`
- Persistent Docker volume for database data

### Example Configuration

```yaml
services:
  postgres:
    image: postgres:16
    container_name: emlynk-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: emlynk_user
      POSTGRES_PASSWORD: emlynk_password
      POSTGRES_DB: emlynk_docs
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

### Commands Used

```bash
docker compose up -d
docker ps
docker exec -it emlynk-postgres psql -U emlynk_user -d emlynk_docs
```

Inside PostgreSQL:

```sql
SELECT current_database();
```

Exit:

```sql
\q
```

### Verification Result
The PostgreSQL container started successfully and the `emlynk_docs` database connection was verified.

---

## 3. Prisma ORM Setup

### Objective
Configure Prisma as the ORM layer between the Node.js backend and PostgreSQL.

### Packages Installed

```bash
npm install prisma @prisma/client
```

### Prisma Initialization

```bash
npx prisma init
```

### Database Connection

The `.env` file contains:

```env
DATABASE_URL="postgresql://emlynk_user:emlynk_password@localhost:5432/emlynk_docs?schema=public"
```

> `.env` is excluded from Git because it may contain passwords and secrets.

### Prisma Schema Base Configuration

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

### Verification

```bash
npx prisma format
npx prisma validate
```

Result:

```text
The schema at prisma\schema.prisma is valid
```

---

## 4. Core Database Models

The project currently uses four core models:

1. `Admin`
2. `User`
3. `Document`
4. `TemporaryData`

### 4.1 Admin
Purpose: Stores administrator account and authorization information.

Main fields:
- `adminId`
- `name`
- `email`
- `passwordHash`
- `role`
- `status`
- `createdDate`
- `updatedDate`

Rules:
- `adminId` is the primary key.
- `email` is unique.
- Passwords are stored as hashes, not plaintext.

### 4.2 User
Purpose: Stores client information.

Main fields:
- `passportId`
- `uniqueId`
- `firstName`
- `otherName`
- `dateOfBirth`
- `placeOfBirth`
- `passportExpiryDate`
- `picture`
- `whatsappNumber`
- `contactNumber`
- `address`
- `job`
- `createdDate`
- `updatedDate`

Rules:
- `passportId` is the primary key.
- `uniqueId` is a separate unique client/backload reference.
- One user can have multiple documents.
- One user can have multiple temporary records.

### 4.3 Document
Purpose: Stores metadata for processed client documents.

Main fields:
- `documentId`
- `passportId`
- `documentType`
- `originalFilename`
- `storedFilename`
- `storagePath`
- `mimeType`
- `fileSize`
- `receivedDate`
- `processingStatus`
- `verificationStatus`
- `ocrConfidence`
- `createdDate`
- `updatedDate`

Relationship:

```text
User 1 ---- many Documents
```

### 4.4 TemporaryData
Purpose: Stores temporary or pending document information before final processing is completed.

Main fields:
- `temporaryId`
- `passportId`
- `uniqueId`
- `whatsappNumber`
- `documentType`
- `temporaryStoragePath`
- `processingStatus`
- `createdDate`

Important note:
- `expires_date` is not included.
- Temporary records remain until successful finalization or approved cleanup.

---

## 5. Database Migration

### Objective
Convert the Prisma schema into real PostgreSQL tables.

### Command

```bash
npx prisma migrate dev --name init_schema
```

This command:
1. Reads `schema.prisma`.
2. Generates migration files.
3. Applies the migration to PostgreSQL.
4. Creates the database tables.
5. Updates the Prisma client.

### Database Verification

```bash
npx prisma studio
```

Expected core tables/models:

```text
admins
users
documents
temporary_data
```

---

## 6. Git Development Workflow

The project follows a checkpoint-based Git workflow requested by the senior developer.

```text
Complete one process
        ↓
Test / verify it
        ↓
Update documentation
        ↓
Commit the change
        ↓
Move to the next process
```

Changes should not be accumulated until the end of a large phase.

### Commit Examples

```bash
git commit -m "chore: initialize backend project"
git commit -m "chore: add PostgreSQL Docker setup"
git commit -m "chore: initialize Prisma"
git commit -m "feat: add admin database model"
git commit -m "feat: add user database model"
git commit -m "feat: add document database model"
git commit -m "feat: add temporary data model"
git commit -m "feat: add initial database migration"
git commit -m "docs: document initial backend and database setup"
```

### Commit Prefixes

| Prefix | Purpose |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `chore:` | Setup, tooling, configuration, maintenance |
| `docs:` | Documentation |
| `test:` | Tests |
| `refactor:` | Code restructuring without changing behavior |

---

## 7. Current Status

Completed:
- Node.js project initialization
- Git repository setup
- `.gitignore`
- README initialization
- Docker PostgreSQL setup
- PostgreSQL connection verification
- Prisma installation
- Prisma configuration
- Core database models
- Prisma schema validation
- Initial database migration
- Database inspection using Prisma Studio
- Git checkpoint commits

---

## 8. Next Development Step

### Seed Data Setup

The next step is to add sample database records so the backend can be tested before WhatsApp, OCR, and storage integrations are added.

Initial seed data should include:
- Admin user
- Client users
- Passport IDs
- Unique IDs
- WhatsApp numbers
- Sample document metadata

Workflow:

```text
Implement
→ Test
→ Document
→ Commit
→ Continue
```

---

## 9. Current High-Level Architecture

```text
Node.js Backend
      |
      v
Prisma ORM
      |
      v
PostgreSQL (Docker)

Future:
WhatsApp
   |
   v
Node.js Backend
   |
   +--> Document Processing / OCR
   +--> PostgreSQL
   +--> Secure Document Storage
   +--> Admin Dashboard
```

---

## Notes

- The previous personal WhatsApp bot is not directly combined with this project.
- This company project is developed as a separate backend system.
- WhatsApp integration will be added after the backend/database foundation is stable.
- External API keys should be added only when the related feature is implemented.
- Each meaningful development process should have matching Markdown documentation and a Git commit.
