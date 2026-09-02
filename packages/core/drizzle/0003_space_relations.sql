CREATE TABLE IF NOT EXISTS `space_relations` (
	`space_id` text NOT NULL,
	`related_id` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`space_id`, `related_id`, `kind`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_relations_kind_check" CHECK("space_relations"."kind" IN ('dependsOn', 'relatedTo')),
	CONSTRAINT "space_relations_self_check" CHECK("space_relations"."space_id" <> "space_relations"."related_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `space_relations_related_idx` ON `space_relations` (`related_id`);
