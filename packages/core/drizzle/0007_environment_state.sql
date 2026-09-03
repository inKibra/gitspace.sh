CREATE TABLE IF NOT EXISTS `environment_space_profiles` (
	`space_id` text PRIMARY KEY NOT NULL REFERENCES `spaces`(`id`) ON DELETE cascade,
	`profile` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `environment_values` (
	`scope` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`scope`, `owner_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `environment_approvals` (
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`scope` text NOT NULL,
	`owner_id` text NOT NULL,
	`execution_hash` text NOT NULL,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`approved_at` text NOT NULL,
	PRIMARY KEY (`scope`, `owner_id`, `execution_hash`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `environment_approvals_project_idx` ON `environment_approvals` (`project_id`, `execution_hash`);
