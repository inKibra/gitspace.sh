CREATE TABLE IF NOT EXISTS `device_grants` (
	`device_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`record_json` text NOT NULL,
	`generation` integer NOT NULL,
	`revoked_at` integer,
	`updated_at` text NOT NULL
);
