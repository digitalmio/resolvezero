CREATE TABLE "profile_rules" (
	"profile_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"action" varchar(20) NOT NULL,
	CONSTRAINT "profile_rules_profile_id_domain_pk" PRIMARY KEY("profile_id","domain")
);
--> statement-breakpoint
CREATE TABLE "profile_source_ips" (
	"ip_address" "inet" PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"doh_token" varchar(255),
	"log_queries" boolean DEFAULT true NOT NULL,
	"log_retention_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_doh_token_unique" UNIQUE("doh_token")
);
--> statement-breakpoint
CREATE TABLE "query_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "query_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"action" varchar(20) NOT NULL,
	"client_ip" "inet",
	"rtt_ms" smallint,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_rules" ADD CONSTRAINT "profile_rules_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_source_ips" ADD CONSTRAINT "profile_source_ips_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_log" ADD CONSTRAINT "query_log_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_log_logged_at_idx" ON "query_log" USING btree ("logged_at");