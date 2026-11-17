-- Per-machine stats rows: every edge writes its own counters instead of
-- read-merging the aggregate row. Top lists are merged inside Postgres so
-- the edge never reads a stats row back (the merge used to cost ~1 row per
-- second per PoP in PlanetScale egress).

ALTER TABLE "stats_hourly" ADD COLUMN "machine" varchar(32) NOT NULL DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE "stats_hourly_device" ADD COLUMN "machine" varchar(32) NOT NULL DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE "stats_minute" ADD COLUMN "machine" varchar(32) NOT NULL DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE "stats_minute_device" ADD COLUMN "machine" varchar(32) NOT NULL DEFAULT 'legacy';--> statement-breakpoint

ALTER TABLE "stats_hourly" DROP CONSTRAINT "stats_hourly_profile_id_hour_pk";--> statement-breakpoint
ALTER TABLE "stats_hourly_device" DROP CONSTRAINT "stats_hourly_device_profile_id_device_hour_pk";--> statement-breakpoint
ALTER TABLE "stats_minute" DROP CONSTRAINT "stats_minute_profile_id_minute_pk";--> statement-breakpoint
ALTER TABLE "stats_minute_device" DROP CONSTRAINT "stats_minute_device_profile_id_device_minute_pk";--> statement-breakpoint

ALTER TABLE "stats_hourly" ADD CONSTRAINT "stats_hourly_profile_id_hour_machine_pk" PRIMARY KEY("profile_id","hour","machine");--> statement-breakpoint
ALTER TABLE "stats_hourly_device" ADD CONSTRAINT "stats_hourly_device_profile_id_device_hour_machine_pk" PRIMARY KEY("profile_id","device","hour","machine");--> statement-breakpoint
ALTER TABLE "stats_minute" ADD CONSTRAINT "stats_minute_profile_id_minute_machine_pk" PRIMARY KEY("profile_id","minute","machine");--> statement-breakpoint
ALTER TABLE "stats_minute_device" ADD CONSTRAINT "stats_minute_device_profile_id_device_minute_machine_pk" PRIMARY KEY("profile_id","device","minute","machine");--> statement-breakpoint


-- Merge a delta top-list into an existing top-list and keep the top `cap`.
-- Called from the rollup upsert so the merge stays inside Postgres.
CREATE OR REPLACE FUNCTION stats_merge_top(existing jsonb, delta jsonb, key_name text, cap integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(key_name, name, 'count', total) ORDER BY total DESC, name),
    '[]'::jsonb
  )
  FROM (
    SELECT name, SUM(count)::bigint AS total
    FROM (
      SELECT value->>key_name AS name, (value->>'count')::bigint AS count
      FROM jsonb_array_elements(COALESCE(existing, '[]'::jsonb)) AS value
      UNION ALL
      SELECT value->>key_name AS name, (value->>'count')::bigint AS count
      FROM jsonb_array_elements(COALESCE(delta, '[]'::jsonb)) AS value
    ) parts
    WHERE name IS NOT NULL
    GROUP BY name
    ORDER BY total DESC, name
    LIMIT cap
  ) merged
$$;
