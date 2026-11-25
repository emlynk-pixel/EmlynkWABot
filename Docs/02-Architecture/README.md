# 02 Architecture

**Purpose:** how the components fit together, how the data is modelled, and how files are stored.

## Files, in reading order

| Document | What it covers |
|---|---|
| [02-system-architecture.md](02-system-architecture.md) | Components, high-level workflow, production topology, confidence bands, why this architecture |
| [03-database-design.md](03-database-design.md) | Models, the passport_id / unique_id identity rule, relationships, migration history, seed data, table-by-table schema, Prisma notes |
| [06-storage-management.md](06-storage-management.md) | Bucket layout, placement rules, naming, checksums and duplicates, document records |

## Related

- [../03-Backend/](../03-Backend/README.md): the backend source layout and API route map
- [../07-Integrations/](../07-Integrations/README.md): WhatsApp, OCR and Google Sheets in detail
- [../09-Deployment/](../09-Deployment/README.md): production topology and environments
