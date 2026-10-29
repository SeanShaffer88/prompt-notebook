CREATE TABLE `notebook_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`write_day` text NOT NULL,
	`writes` integer DEFAULT 0 NOT NULL
);
