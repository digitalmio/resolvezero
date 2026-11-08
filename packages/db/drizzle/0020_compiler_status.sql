CREATE TABLE IF NOT EXISTS "compiler_status" (
  "instance" text PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_cycle_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_refresh_at" timestamp with time zone,
  "last_error_at" timestamp with time zone,
  "last_error" text,
  "lists_total" integer DEFAULT 0 NOT NULL,
  "lists_stale" integer DEFAULT 0 NOT NULL,
  "lists_compiled" integer DEFAULT 0 NOT NULL,
  "lists_failed" integer DEFAULT 0 NOT NULL,
  "lists_changed" integer DEFAULT 0 NOT NULL,
  "missing_artifacts" integer DEFAULT 0 NOT NULL,
  "oldest_compiled_at" timestamp with time zone,
  "blocklist_version" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
