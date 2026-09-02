CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`omp_session_id` text NOT NULL,
	`session_file` text NOT NULL,
	`state` text NOT NULL,
	`last_event_offset` integer DEFAULT 0 NOT NULL,
	`activity_json` text DEFAULT '{"active":false,"reasons":[]}' NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_sessions_state_check" CHECK("agent_sessions"."state" IN ('opening', 'active', 'draining', 'closed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_omp_session_unique` ON `agent_sessions` (`omp_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_space_unique` ON `agent_sessions` (`space_id`);--> statement-breakpoint
CREATE TABLE `artifact_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`cache_path` text,
	`state` text NOT NULL,
	`last_accessed_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "artifact_blobs_size_check" CHECK("artifact_blobs"."size" >= 0),
	CONSTRAINT "artifact_blobs_state_check" CHECK("artifact_blobs"."state" IN ('remote', 'cached', 'dirty', 'uploading'))
);
--> statement-breakpoint
CREATE TABLE `artifact_entries` (
	`scope_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	`size` integer NOT NULL,
	`media_type` text,
	`generation` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope_id`, `path`),
	FOREIGN KEY (`scope_id`) REFERENCES `artifact_scopes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_entries_size_check" CHECK("artifact_entries"."size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `artifact_entries_blob_idx` ON `artifact_entries` (`blob_hash`);--> statement-breakpoint
CREATE TABLE `artifact_promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_space_id` text NOT NULL,
	`source_generation` integer NOT NULL,
	`expected_base_generation` integer NOT NULL,
	`committed_base_generation` integer,
	`paths` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_promotions_state_check" CHECK("artifact_promotions"."state" IN ('planned', 'committed', 'conflict'))
);
--> statement-breakpoint
CREATE INDEX `artifact_promotions_project_idx` ON `artifact_promotions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `artifact_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`dirty` integer DEFAULT false NOT NULL,
	`manifest_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifact_scopes_generation_check" CHECK("artifact_scopes"."generation" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_scopes_space_unique` ON `artifact_scopes` (`space_id`);--> statement-breakpoint
CREATE TABLE `fact_events` (
	`offset` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`scope` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fact_events_scope_check" CHECK("fact_events"."scope" IN ('machine', 'project', 'workspace', 'session', 'artifact', 'code')),
	CONSTRAINT "fact_events_operation_check" CHECK("fact_events"."operation" IN ('created', 'updated', 'removed', 'append', 'invalidate', 'code-version'))
);
--> statement-breakpoint
CREATE INDEX `fact_events_project_offset_idx` ON `fact_events` (`project_id`,`offset`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_reference` text,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_unique` ON `projects` (`name`);--> statement-breakpoint
CREATE TABLE `space_placements` (
	`space_id` text PRIMARY KEY NOT NULL,
	`holder_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`root_path` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`acquired_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_placements_generation_check" CHECK("space_placements"."generation" >= 0),
	CONSTRAINT "space_placements_state_check" CHECK("space_placements"."state" IN ('opening', 'open', 'closing', 'closed'))
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`phase` text,
	`closed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "spaces_kind_check" CHECK("spaces"."kind" IN ('base', 'worktree')),
	CONSTRAINT "spaces_phase_check" CHECK(("spaces"."kind" = 'base' AND "spaces"."phase" IS NULL) OR ("spaces"."kind" = 'worktree' AND "spaces"."phase" IN ('plan', 'code', 'review', 'ship')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_project_kind_name_unique` ON `spaces` (`project_id`,`kind`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_project_base_unique` ON `spaces` (`project_id`) WHERE "spaces"."kind" = 'base';--> statement-breakpoint
CREATE INDEX `spaces_project_idx` ON `spaces` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `transcript_events` (
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `ordinal`),
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
