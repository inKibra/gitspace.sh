CREATE TABLE `space_cleanup_jobs` (
  `space_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `generation` integer NOT NULL,
  `root_path` text NOT NULL,
  `session_files` text NOT NULL,
  `session_ids` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('prepared', 'committed')),
  `checkpoint_revision` integer,
  `manifest_key` text,
  `manifest_hash` text,
  `error` text,
  `created_at` text NOT NULL
);
