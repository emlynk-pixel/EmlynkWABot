# Admin Authentication

## Objective
Implement and verify secure administrator authentication using bcrypt password hashing and JWT-based access control.

## Implemented Components

### 1. Password Hashing
The project uses `bcrypt` to hash administrator passwords and compare login passwords against stored hashes.

Relevant file:
- `src/utils/password.js`

### 2. Reusable Prisma Client
A reusable Prisma database client was added for backend access to PostgreSQL.

Relevant file:
- `src/config/prisma.js`

### 3. Admin Login Endpoint

```http
POST /auth/login
```

Flow:

```text
Email + password
      ↓
Find admin by email
      ↓
Compare bcrypt password hash
      ↓
Generate JWT
      ↓
Return token
```

Successful response:

```json
{
  "message": "Login successful",
  "token": "<jwt-token>"
}
```

Invalid credentials:

```json
{
  "message": "Invalid email or password"
}
```

### 4. JWT Configuration
The generated token includes administrator information such as:
- `adminId`
- `email`
- `role`

The signing secret is stored in `.env`:

```env
JWT_SECRET="<secure-random-secret>"
```

The actual secret is not committed to Git.

Current token expiry:

```text
1 hour
```

### 5. JWT Authentication Middleware
Relevant file:
- `src/middleware/auth.js`

The middleware:
- Reads the `Authorization` header.
- Requires `Bearer <token>` format.
- Verifies the JWT using `JWT_SECRET`.
- Rejects missing, invalid, or expired tokens.
- Attaches decoded admin data to the request.

### 6. Protected Admin Route

```http
GET /auth/me
```

Required header:

```http
Authorization: Bearer <jwt-token>
```

Example response:

```json
{
  "admin": {
    "adminId": "ADM001",
    "name": "System Admin",
    "email": "admin@emlynk.com",
    "role": "ADMIN",
    "status": "ACTIVE"
  }
}
```

## Verification Tests

The authentication flow was tested successfully.

### Valid Login
- HTTP 200
- JWT returned

### Invalid Password
- HTTP 401
- `Invalid email or password`

### Protected Route with Valid Token
- HTTP 200
- Admin information returned

### Protected Route without Token
- HTTP 401
- `Authentication token is required`

### Protected Route with Invalid Token
- HTTP 401
- `Invalid or expired token`

## Security Notes
- Plain-text passwords are not stored.
- Password verification uses bcrypt.
- JWT signing secret is stored in environment variables.
- `.env` is excluded from Git.
- Login errors do not reveal whether a specific email exists.
- Protected routes require a valid JWT.

## Current Authentication Status

```text
bcrypt password hashing
        ↓
Admin database lookup
        ↓
Password verification
        ↓
JWT generation
        ↓
JWT middleware
        ↓
Protected admin route
```

The initial admin authentication flow is complete and verified.

## Git Checkpoint

```bash
git add Docs/03-admin-authentication.md
git commit -m "docs: document admin authentication flow"
git status
```

## Next Step

According to the project proposal, the next phase is:

```text
Phase 3 — WhatsApp Integration
```

The next development checkpoint will start with the WhatsApp webhook foundation.
