# TripForge — Submission Folder Structure

Task ID: 108
Project Type: pure_backend
Stack: Express + TypeScript + Prisma + MySQL

---

## ZIP Root Layout

```
108/
├── docs/
│   ├── design.md
│   ├── api-spec.md
│   ├── questions.md
│   ├── acceptance-checklist.md
│   ├── features.md
│   ├── build-order.md
│   ├── structure.md
│   └── AI-self-test.md
├── repo/                             # project code lives directly here
├── sessions/
│   ├── develop-1.json                # primary development session
│   └── bugfix-1.json                 # remediation session (if needed)
├── metadata.json
└── prompt.md
```

### metadata.json

```json
{
  "prompt": "...",
  "project_type": "pure_backend",
  "frontend_language": "none",
  "backend_language": "typescript",
  "frontend_framework": "none",
  "backend_framework": "express",
  "database": "mysql"
}
```

---

## repo/ — Full Project Structure

```
repo/
├── src/
│   ├── app.ts                        # express app setup
│   ├── server.ts                     # server bootstrap
│   ├── config/
│   │   ├── database.ts               # Prisma configuration
│   │   ├── auth.ts                   # JWT/session config
│   │   └── environment.ts            # env variables
│   ├── controllers/
│   │   ├── auth.controller.ts        # authentication endpoints
│   │   ├── users.controller.ts       # user management
│   │   ├── itineraries.controller.ts # itinerary CRUD
│   │   ├── resources.controller.ts   # attractions, lodging, etc.
│   │   ├── import.controller.ts      # data import/export
│   │   ├── models.controller.ts      # ML model management
│   │   └── notifications.controller.ts
│   ├── services/
│   │   ├── auth.service.ts           # login, JWT, device registration
│   │   ├── rbac.service.ts           # role-based access control
│   │   ├── itinerary.service.ts      # itinerary logic
│   │   ├── routing.service.ts        # route optimization engine
│   │   ├── validation.service.ts     # conflict detection
│   │   ├── import.service.ts         # Excel/CSV processing
│   │   ├── model.service.ts          # ML inference
│   │   ├── notification.service.ts   # local notifications
│   │   └── encryption.service.ts     # AES-256 encryption
│   ├── middleware/
│   │   ├── auth.middleware.ts        # JWT validation
│   │   ├── rbac.middleware.ts        # permission checks
│   │   ├── rate-limit.middleware.ts  # rate limiting
│   │   ├── audit.middleware.ts       # audit logging
│   │   └── idempotency.middleware.ts # idempotency keys
│   ├── models/
│   │   └── prisma/                   # Prisma schema and generated client
│   ├── routes/
│   │   ├── auth.routes.ts
│   │   ├── users.routes.ts
│   │   ├── itineraries.routes.ts
│   │   ├── resources.routes.ts
│   │   ├── import.routes.ts
│   │   ├── models.routes.ts
│   │   └── notifications.routes.ts
│   ├── utils/
│   │   ├── logger.ts                 # structured logging
│   │   ├── validation.ts             # input validation
│   │   ├── crypto.ts                 # encryption utilities
│   │   ├── excel.ts                  # Excel processing
│   │   └── errors.ts                 # error handling
│   └── types/
│       ├── auth.types.ts
│       ├── itinerary.types.ts
│       ├── import.types.ts
│       └── api.types.ts
├── prisma/
│   ├── schema.prisma                 # database schema
│   ├── migrations/                   # migration files
│   └── seed.ts                       # seed data
├── tests/
│   ├── unit/
│   │   ├── auth.test.ts
│   │   ├── itinerary.test.ts
│   │   ├── routing.test.ts
│   │   ├── import.test.ts
│   │   └── models.test.ts
│   └── integration/
│       ├── auth.api.test.ts
│       ├── itineraries.api.test.ts
│       ├── resources.api.test.ts
│       ├── import.api.test.ts
│       └── models.api.test.ts
├── uploads/                          # temporary file storage
├── exports/                          # generated exports
├── models/                           # ML model files
├── templates/                        # Excel/CSV templates
├── dist/                             # generated build output (do not include in submission ZIP)
├── run_tests.sh
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── .dockerignore
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── jest.config.js
└── README.md
```

Notes:
- `node_modules/` is intentionally excluded from the canonical structure and must never be part of the submission package.
- `dist/` may exist during local development but is treated as generated output and must be excluded from the submission package.

---

## What Must NOT Be in the ZIP

- no `node_modules/` directory
- no `dist/` or compiled output
- no `.env` with real credentials (only `.env.example`)
- no temp files in `uploads/` or `exports/`
- no actual ML model files (only placeholders)

---

## Sessions Naming Rules

- primary development session → `sessions/develop-1.json`
- remediation session → `sessions/bugfix-1.json`
- additional sessions → `develop-2.json`, `bugfix-2.json`, etc.

---

## Submission Checklist

- [ ] `docker compose up` completes without errors
- [ ] Cold start tested in clean environment
- [ ] README has startup command, ports, test credentials
- [ ] `docs/design.md` and `docs/api-spec.md` present
- [ ] `docs/questions.md` has question + assumption + solution for each item
- [ ] Unit and integration tests exist, `run_tests.sh` passes
- [ ] No `node_modules/`, `dist/`, or compiled output in ZIP
- [ ] No real credentials in any config file
- [ ] All prompt requirements implemented — no silent substitutions
- [ ] `sessions/develop-1.json` trajectory file present
- [ ] `metadata.json` at root with all required fields
- [ ] `prompt.md` at root, unmodified
- [ ] Prisma migrations work correctly
- [ ] MySQL database initializes properly
- [ ] API endpoints documented and functional
- [ ] Offline operation verified (no external dependencies)
