CREATE TABLE `space_relations_new` (
	`space_id` text NOT NULL,
	`related_id` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`space_id`, `related_id`, `kind`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_relations_kind_check" CHECK("kind" IN ('dependsOn', 'relatedTo', 'stackedOn')),
	CONSTRAINT "space_relations_self_check" CHECK("space_id" <> "related_id")
);
--> statement-breakpoint
INSERT INTO `space_relations_new` (`space_id`, `related_id`, `kind`) SELECT `space_id`, `related_id`, `kind` FROM `space_relations`;
--> statement-breakpoint
DROP INDEX IF EXISTS `space_relations_related_idx`;
--> statement-breakpoint
DROP TABLE `space_relations`;
--> statement-breakpoint
ALTER TABLE `space_relations_new` RENAME TO `space_relations`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `space_relations_related_idx` ON `space_relations` (`related_id`);
