# Issue #982: Migration Error on v2.5.0

**Source issue**: [rybbit-io/rybbit#982](https://github.com/rybbit-io/rybbit/issues/982)

---

## Executive Summary

In v2.5.0, rybbit switched from Drizzle `db:push` to `db:migrate` (file-based migrations) and introduced a squashed initial migration `0000_premium_jubilee.sql`[^1]. This migration contains a **structural inconsistency**: `CREATE TABLE` statements use **unqualified table names** (e.g., `CREATE TABLE IF NOT EXISTS "user"`), while FK constraints use **explicitly schema-qualified references** (e.g., `REFERENCES "public"."user"("id")`). On Azure PostgreSQL — and any setup where the PostgreSQL role's `search_path` defaults to a user-specific schema rather than `public` — tables end up created in the wrong schema, causing the FK constraint to fail with `relation "public.user" does not exist`. A secondary issue is the use of the old Drizzle FK pattern (`EXCEPTION WHEN duplicate_object THEN null`) which only catches one specific PostgreSQL error code and does not handle the `undefined_table` (42P01) error that surfaces here.

---

## The Change That Introduced the Bug (v2.5.0)

Commit `e22c2e14` ("Enhance Docker entrypoint and update migration process #948") made three key changes[^2]:

1. **Switched from `db:push` to `db:migrate`** — `docker-entrypoint.sh` changed from `npm run db:push -- --force` to `npm run db:migrate`.
2. **Added `0000_premium_jubilee.sql`** — A new squashed/combined migration file (553 lines) was introduced, designed to work for both fresh installs and upgrades from v2.4.0.
3. **Updated Dockerfile** — Now includes the `drizzle/` directory to ensure migration files are packaged in the image.

Before v2.5.0, there was **no `drizzle/` directory** and no migration files. `db:push` directly synced the schema to the database without any SQL migration files. Users upgrading from v2.4.0 have no `__drizzle_migrations` table, so `drizzle-kit migrate` treats ALL migrations as pending and tries to apply them all.

---

## Root Cause: Schema-Qualification Mismatch

### The Migration File Structure

`0000_premium_jubilee.sql` is a squashed migration with three sections[^3]:

| Lines | Content | Purpose |
|-------|---------|---------|
| 1–355 | `CREATE TABLE IF NOT EXISTS "tablename"` | Create all tables — works for fresh installs |
| 356–411 | `ALTER TABLE "x" ADD COLUMN IF NOT EXISTS "y"` | Add columns added post-initial-schema — works for v2.4.0 upgrades |
| 412–560+ | `DO $$ BEGIN ALTER TABLE ADD CONSTRAINT ... EXCEPTION WHEN duplicate_object THEN null; END $$;` | FK constraints in old Drizzle format |

### The Inconsistency

**CREATE TABLE statements** (all unqualified, no schema prefix):
```sql
-- line 306
CREATE TABLE IF NOT EXISTS "user" (
    "id" text PRIMARY KEY NOT NULL,
    ...
);
```

**FK constraint statements** (all schema-qualified):
```sql
-- line 412-416
DO $$ BEGIN
 ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk"
   FOREIGN KEY ("userId") REFERENCES "public"."user"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
```

When `CREATE TABLE IF NOT EXISTS "user"` runs, PostgreSQL creates the table in the **first schema in the connection's `search_path`** where the user has `CREATE` privilege. The standard default is `"$user", public`, meaning if a schema named after the current PostgreSQL role exists, it becomes the target. This is common on Azure PostgreSQL Flexible Server, which may provision a user-specific schema automatically.

If the `user` table ends up in schema `azureuser` (or whatever role name the user configured), then `REFERENCES "public"."user"("id")` fails with:
```
cause: error: relation "public.user" does not exist
```

### Why the Error Isn't Handled

The FK block uses the **old Drizzle migration pattern**[^4]:
```sql
EXCEPTION
 WHEN duplicate_object THEN null;
```

This handles only PostgreSQL error code `42710` (duplicate_object). The `relation does not exist` error is code `42P01` (undefined_table), which is **NOT caught** and propagates as an unhandled exception — crashing the migration.

The newer migrations (0001–0004) use a safer `IF NOT EXISTS` check pattern[^5]:
```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'account_userId_user_id_fk'
  ) THEN
    ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" ...;
  END IF;
END $$;
```
However, even this pattern would still fail if `"public"."user"` doesn't exist, since the `IF NOT EXISTS` only skips adding an already-existing constraint, not one whose referenced table is missing.

### Why It Also Fails on Fresh Installs

On a fresh install with an Azure PostgreSQL connection where the role has a personal schema in the `search_path`:

1. `CREATE TABLE IF NOT EXISTS "user"` → creates `azureuser.user` (in role's own schema)
2. FK: `REFERENCES "public"."user"("id")` → **`public.user` doesn't exist** → error

This explains why the bug affects both upgrades **and** clean slate installs on Azure.

---

## Supporting Evidence

### drizzle.config.ts — No Explicit `search_path`[^6]

```typescript
export default defineConfig({
  schema: "./src/db/postgres/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.POSTGRES_HOST || "postgres",
    port: parseInt(process.env.POSTGRES_PORT || "5432"),
    database: process.env.POSTGRES_DB || "analytics",
    user: process.env.POSTGRES_USER || "frog",
    password: process.env.POSTGRES_PASSWORD || "frog",
    ssl: false,       // ← also problematic for Azure which requires SSL
  },
  verbose: true,
  schemaFilter: ["public"],   // ← tells drizzle-kit what to manage, does NOT set connection search_path
  tablesFilter: ['!pg_*'],
});
```

`schemaFilter: ["public"]` controls which schemas drizzle-kit introspects, but does **not** set the `search_path` for the database connection. The migration SQL therefore runs without an explicit `search_path = public` setting.

### Enum Type Uses Explicit Schema — Tables Do Not[^3]

The ENUM type at the top of `0000_premium_jubilee.sql` IS explicitly schema-qualified:
```sql
-- line 1-5
DO $$ BEGIN
 CREATE TYPE "public"."import_platform_enum" AS ENUM('umami', 'simple_analytics');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

But all 20+ `CREATE TABLE IF NOT EXISTS` statements throughout the file use **no schema prefix**. This is the source of the inconsistency.

### The Snapshot Confirms `public` Schema Intent[^7]

The `0000_snapshot.json` shows all tables tagged under `"public.tablename"` (e.g., `"public.account"`, `"public.user"`), confirming the intent is for all tables to live in the `public` schema. The generated SQL just fails to enforce this.

---

## Secondary Issue: `ssl: false` in drizzle.config.ts

Azure PostgreSQL requires SSL/TLS by default. The `ssl: false` setting in `drizzle.config.ts`[^6] would prevent `drizzle-kit migrate` from connecting to Azure unless SSL enforcement is disabled on the Azure side. If the user has configured their Azure instance to require SSL, this would block the migration entirely — but this is a secondary configuration issue, not the direct cause of the FK error.

---

## Architecture Diagram: What Happens on Azure

```
Fresh install on Azure PostgreSQL
(role: azureuser, schema: azureuser exists in search_path)

0000_premium_jubilee.sql runs:

  Line 306:  CREATE TABLE IF NOT EXISTS "user" (...)
              ↓
              search_path = "azureuser", public
              ↓
              table created as: azureuser.user  ← WRONG SCHEMA!

  Line 412:  ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk"
               FOREIGN KEY ("userId") REFERENCES "public"."user"("id")
              ↓
              PostgreSQL looks for: public.user
              ↓
              public.user does NOT exist (it's in azureuser.user)
              ↓
              ERROR: relation "public.user" does not exist (42P01)
              ↓
              NOT caught by EXCEPTION WHEN duplicate_object (42710)
              ↓
              Migration FAILS
```

---

## Proposed Fix

### Option 1 (Immediate Fix): Add `SET search_path TO public` to the migration file

Add as the very first statement in `0000_premium_jubilee.sql`:

```sql
SET search_path TO public;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."import_platform_enum" AS ENUM('umami', 'simple_analytics');
...
```

This ensures all subsequent `CREATE TABLE IF NOT EXISTS "tablename"` statements create tables in the `public` schema, matching where the FK constraints expect them.

### Option 2 (Robust Fix): Add `search_path` to connection config

In `drizzle.config.ts`, update the database connection to explicitly set `search_path`:

```typescript
dbCredentials: {
  host: process.env.POSTGRES_HOST || "postgres",
  // ... other params
  ssl: process.env.POSTGRES_SSL === "true" ? true : false,  // also fix SSL for Azure
},
// Add connection string with search_path, or use:
// connectionString: `postgresql://...?options=-c search_path=public`
```

Note: The `pg` library and `drizzle-kit` support `search_path` via connection string options.

### Option 3 (Long-term): Update FK patterns to use `IF NOT EXISTS` style

Replace all FK blocks in `0000_premium_jubilee.sql` that use:
```sql
DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;
```
with the newer pattern used in migrations 0001–0004:
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = '...') THEN
    ALTER TABLE ... ADD CONSTRAINT ...;
  END IF;
END $$;
```

This does NOT fix the root cause (wrong schema) but is more resilient for the upgrade scenario.

---

## Key Files

| File | Relevance |
|------|-----------|
| `server/drizzle/0000_premium_jubilee.sql` | Contains the buggy migration (unqualified CREATE TABLE + schema-qualified FK refs) |
| `server/drizzle.config.ts` | Missing `search_path` in connection config; `ssl: false` may block Azure |
| `server/docker-entrypoint.sh` | Runs `npm run db:migrate` at startup |
| `server/drizzle/meta/_journal.json` | Migration registry (5 migrations: 0000–0004) |

---

## Confidence Assessment

| Finding | Confidence | Notes |
|---------|-----------|-------|
| `0000_premium_jubilee.sql` is the squashed migration introduced in v2.5.0 | **High** | Confirmed via git log |
| CREATE TABLE uses unqualified names; FKs use `"public"."tablename"` | **High** | Directly visible in the migration file |
| FK error handler (`duplicate_object`) doesn't catch `undefined_table` | **High** | Standard PostgreSQL error code behavior |
| Azure PostgreSQL `search_path` causes tables in user-specific schema | **Medium** | Plausible given Azure behavior; not directly confirmed from code |
| `ssl: false` blocks Azure connections | **Medium** | Azure requires SSL by default; user may have disabled it |
| `schemaFilter: ["public"]` doesn't affect connection search_path | **High** | Drizzle Kit behavior is well-documented |

---

## Footnotes

[^1]: `server/drizzle/0000_premium_jubilee.sql` — 553-line squashed migration introduced in v2.5.0
[^2]: Commit `e22c2e14` — "Enhance Docker entrypoint and update migration process (#948)", March 19 2026
[^3]: `server/drizzle/0000_premium_jubilee.sql:1-416` — ENUM at line 1, CREATE TABLE at line 7–354, ALTER TABLE at 356–411, FK constraints at 412+
[^4]: `server/drizzle/0000_premium_jubilee.sql:412-416` — Old Drizzle FK pattern with `EXCEPTION WHEN duplicate_object THEN null`
[^5]: `server/drizzle/0002_short_bishop.sql:24-70` — New `IF NOT EXISTS` pattern used in migrations 0001–0004
[^6]: `server/drizzle.config.ts:1-21` — Connection config with `ssl: false` and `schemaFilter: ["public"]`
[^7]: `server/drizzle/meta/0000_snapshot.json:7` — Tables listed as `"public.account"`, `"public.user"`, etc.
