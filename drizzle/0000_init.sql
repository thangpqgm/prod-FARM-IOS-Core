CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_udid` text NOT NULL,
	`handle` text NOT NULL,
	`keywords` text NOT NULL,
	`personality` text DEFAULT 'casual' NOT NULL,
	`minutes_per_session` integer DEFAULT 15 NOT NULL,
	`keywords_per_session` integer DEFAULT 2 NOT NULL,
	`for_you_minutes` integer DEFAULT 3 NOT NULL,
	`daily_times` text DEFAULT '[]' NOT NULL,
	`niche_filter` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_device_handle` ON `accounts` (`device_udid`,`handle`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`keyword` text,
	`caption` text,
	`matched_niche` integer,
	`liked` integer NOT NULL,
	`saved` integer NOT NULL,
	`watched_ms` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `interactions_session` ON `interactions` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`device_udid` text NOT NULL,
	`trigger` text NOT NULL,
	`slot` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`videos_viewed` integer DEFAULT 0 NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`saves` integer DEFAULT 0 NOT NULL,
	`niche_matches` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_account_started` ON `sessions` (`account_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_account_slot` ON `sessions` (`account_id`,`slot`);