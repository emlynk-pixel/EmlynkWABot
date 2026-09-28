# EmlynkWABot — Official Coding Standards

## 1. General Principles
- **MUST** prioritize correctness, security, and data integrity over cleverness.
- **MUST NOT** introduce abstractions (Repositories, DI Containers) without concrete architectural justification.
- **AVOID** premature optimization; optimize only based on measured bottlenecks.

## 2. Naming Conventions
- **MUST** use camelCase for variables, function names, and methods.
- **MUST** use PascalCase for classes, React components, and TypeScript types.
- **MUST** use UPPER_SNAKE_CASE for exported constants, thresholds, and enums.
- **MUST** keep database column names snake_case mapped to camelCase in Prisma schema.

## 3. Function Design
- **SHOULD** limit function length to <= 60 lines. Functions exceeding 100 lines MUST be decomposed.
- **MUST** write functions that do one logical thing and return predictable shapes.
- **SHOULD** prefer pure helper functions for calculations and formatting.

## 4. File & Module Structure
- **MUST** maintain clear separation between Routes (`src/routes`), Services (`src/services`), and Utilities (`src/utils`).
- **MUST** keep React components focused; dialogs and heavy sub-views MUST live in dedicated component files.

## 5. Error Handling
- **MUST** use domain-specific error classes extending `Error` for expected business/validation failures.
- **MUST NOT** swallow errors silently; always log with `safeErrorInfo`.
- **MUST NOT** expose stack traces, database schema details, or raw query text in API responses.

## 6. Async & Concurrency
- **MUST** use `async/await` and handle promise rejections.
- **MUST** enforce explicit timeouts on external I/O (Supabase, Meta API, SMTP).
- **MUST** guard concurrent mutations on shared records using PostgreSQL transactions and `SELECT ... FOR UPDATE`.

## 7. Database Practices
- **MUST** use Prisma parameterized queries; raw SQL concatenation is strictly FORBIDDEN.
- **MUST** define appropriate indexes for columns used in `WHERE`, `ORDER BY`, or foreign key relationships.
- **SHOULD** avoid in-memory pagination for unbounded database queries.

## 8. Storage Practices
- **MUST** sanitize storage paths using `assertSafeSegment` and `sanitizeFileName`.
- **MUST** determine storage file extensions exclusively from verified MIME signatures.
- **MUST NOT** accept arbitrary storage paths from user or client input.

## 9. Security & Validation
- **MUST** validate all request parameters, query strings, and request bodies against strict schemas/regexes.
- **MUST** enforce RBAC via `requireRole` on every administrative route.
- **MUST** compare security-sensitive tokens using `crypto.timingSafeEqual`.
- **MUST** store passwords using bcrypt (minimum 10 rounds).

## 10. Logging & Privacy
- **MUST NOT** log raw PII (passport numbers, full telephone numbers, full names, extracted document text).
- **MUST** pass all logged error messages through `safeErrorText`.

## 11. Testing
- **MUST** accompany any new service, route, or bug fix with automated unit or integration tests.
- **MUST** ensure test execution remains isolated from live external networks and services.

## 12. Git & Definition of Done
- **MUST** write atomic commits following Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
- **Definition of Done:** Code written + tests passing + documentation updated + security review verified.
