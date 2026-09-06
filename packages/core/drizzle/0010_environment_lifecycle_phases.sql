-- Legacy local runs are historical cache entries, never cloud provisioning evidence.
UPDATE `environment_runs`
SET `status` = 'abandoned', `finished_at` = COALESCE(`finished_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE `status` = 'running' AND `phase` IN ('setup', 'select', 'remove');
--> statement-breakpoint
UPDATE `environment_runs`
SET `output` = '[Legacy local ' || `phase` || ' run; historical label only, not canonical cloud lifecycle evidence]' || char(10) || `output`,
    `phase` = CASE `phase`
  WHEN 'setup' THEN 'machine/prepare'
  WHEN 'select' THEN 'workspace/materialize'
  WHEN 'remove' THEN 'cloud/destroy'
END
WHERE `phase` IN ('setup', 'select', 'remove');
