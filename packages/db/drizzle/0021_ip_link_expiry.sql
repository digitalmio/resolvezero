-- Linked source IPs are a privacy-sensitive mapping: an IP can change owner or
-- be shared behind CGNAT. Expire links that have not been seen for 30 days and
-- keep last_seen_at fresh from the edge.
ALTER TABLE "profile_source_ips" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Refreshing last_seen_at must not bump the edge config version (it would
-- reload every profile's snapshot on each touch). Only re-links do.
DROP TRIGGER IF EXISTS edge_config_source_ips_trigger ON profile_source_ips;--> statement-breakpoint
CREATE TRIGGER edge_config_source_ips_trigger
AFTER INSERT OR DELETE OR UPDATE OF profile_id ON profile_source_ips
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();
