# Database changes

- Never create Drizzle migrations. Apply schema changes directly with `bun run db:push` inside the Docker container.
- Dump the current database first when data needs to be preserved before a destructive schema update.
- Schema push is manual, never part of application startup (including development). Before first launch or after schema changes, run `docker compose run --rm --no-deps antigone bun run db:push` after making any needed backup, then start the service.
