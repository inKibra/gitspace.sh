CREATE TABLE IF NOT EXISTS `released_spaces` (
	`space_id` text PRIMARY KEY NOT NULL REFERENCES `spaces`(`id`) ON DELETE cascade,
	`generation` integer NOT NULL,
	`released_at` text NOT NULL
);
