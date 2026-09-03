CREATE TABLE IF NOT EXISTS `environment_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`space_id` text NOT NULL REFERENCES `spaces`(`id`) ON DELETE cascade,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`terminal_name` text,
	`execution_hashes_json` text NOT NULL,
	`results_json` text NOT NULL,
	`output` text NOT NULL,
	`exit_code` integer,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `environment_runs_space_phase_idx` ON `environment_runs` (`space_id`, `phase`, `started_at`);
