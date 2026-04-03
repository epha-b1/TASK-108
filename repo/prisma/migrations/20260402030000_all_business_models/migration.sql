-- CreateTable: resources
CREATE TABLE `resources` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `street_line` VARCHAR(255) NULL,
    `city` VARCHAR(255) NULL,
    `region` VARCHAR(255) NULL,
    `country` VARCHAR(255) NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `min_dwell_minutes` INTEGER NOT NULL DEFAULT 30,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: resource_hours
CREATE TABLE `resource_hours` (
    `id` VARCHAR(191) NOT NULL,
    `resource_id` VARCHAR(191) NOT NULL,
    `day_of_week` INTEGER NOT NULL,
    `open_time` VARCHAR(5) NOT NULL,
    `close_time` VARCHAR(5) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: resource_closures
CREATE TABLE `resource_closures` (
    `id` VARCHAR(191) NOT NULL,
    `resource_id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `reason` VARCHAR(255) NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: travel_time_matrices
CREATE TABLE `travel_time_matrices` (
    `id` VARCHAR(191) NOT NULL,
    `from_resource_id` VARCHAR(191) NOT NULL,
    `to_resource_id` VARCHAR(191) NOT NULL,
    `travel_minutes` INTEGER NOT NULL,
    `transport_mode` VARCHAR(20) NOT NULL DEFAULT 'walking',
    `updated_at` DATETIME(3) NOT NULL,
    UNIQUE INDEX `ttm_from_to_mode_key`(`from_resource_id`, `to_resource_id`, `transport_mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: itineraries
CREATE TABLE `itineraries` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `destination` VARCHAR(255) NULL,
    `start_date` DATE NULL,
    `end_date` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
    `share_token` VARCHAR(255) NULL,
    `share_expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    UNIQUE INDEX `itineraries_share_token_key`(`share_token`),
    INDEX `itineraries_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: itinerary_versions
CREATE TABLE `itinerary_versions` (
    `id` VARCHAR(191) NOT NULL,
    `itinerary_id` VARCHAR(191) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `diff_metadata` JSON NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `itinerary_versions_itinerary_id_version_number_key`(`itinerary_id`, `version_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: itinerary_items
CREATE TABLE `itinerary_items` (
    `id` VARCHAR(191) NOT NULL,
    `itinerary_id` VARCHAR(191) NOT NULL,
    `resource_id` VARCHAR(191) NOT NULL,
    `day_number` INTEGER NOT NULL,
    `start_time` VARCHAR(5) NOT NULL,
    `end_time` VARCHAR(5) NOT NULL,
    `notes` TEXT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: import_batches
CREATE TABLE `import_batches` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `entity_type` VARCHAR(100) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `total_rows` INTEGER NOT NULL DEFAULT 0,
    `success_rows` INTEGER NOT NULL DEFAULT 0,
    `error_rows` INTEGER NOT NULL DEFAULT 0,
    `idempotency_key` VARCHAR(255) NOT NULL,
    `rollback_until` DATETIME(3) NOT NULL,
    `validated_data` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    UNIQUE INDEX `import_batches_idempotency_key_key`(`idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: import_errors
CREATE TABLE `import_errors` (
    `id` VARCHAR(191) NOT NULL,
    `batch_id` VARCHAR(191) NOT NULL,
    `row_number` INTEGER NOT NULL,
    `field` VARCHAR(255) NULL,
    `message` TEXT NOT NULL,
    `raw_data` JSON NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: ml_models
CREATE TABLE `ml_models` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `version` VARCHAR(50) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'inactive',
    `file_path` VARCHAR(500) NULL,
    `config` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `ml_models_name_version_key`(`name`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: ab_allocations
CREATE TABLE `ab_allocations` (
    `id` VARCHAR(191) NOT NULL,
    `model_id` VARCHAR(191) NOT NULL,
    `group_name` VARCHAR(100) NOT NULL,
    `percentage` DECIMAL(5, 2) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: notification_templates
CREATE TABLE `notification_templates` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(500) NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `notification_templates_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: notifications
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `template_id` VARCHAR(191) NULL,
    `type` VARCHAR(100) NOT NULL,
    `subject` VARCHAR(500) NULL,
    `message` TEXT NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `delivered` BOOLEAN NOT NULL DEFAULT false,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `next_retry_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `notifications_user_id_read_idx`(`user_id`, `read`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: outbox_messages
CREATE TABLE `outbox_messages` (
    `id` VARCHAR(191) NOT NULL,
    `notification_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivered_at` DATETIME(3) NULL,
    UNIQUE INDEX `outbox_messages_notification_id_key`(`notification_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: user_notification_settings
CREATE TABLE `user_notification_settings` (
    `user_id` VARCHAR(191) NOT NULL,
    `blacklisted` BOOLEAN NOT NULL DEFAULT false,
    `daily_cap` INTEGER NOT NULL DEFAULT 20,
    `daily_sent` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `resource_hours` ADD CONSTRAINT `resource_hours_resource_id_fkey` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `resource_closures` ADD CONSTRAINT `resource_closures_resource_id_fkey` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `travel_time_matrices` ADD CONSTRAINT `travel_time_matrices_from_resource_id_fkey` FOREIGN KEY (`from_resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `travel_time_matrices` ADD CONSTRAINT `travel_time_matrices_to_resource_id_fkey` FOREIGN KEY (`to_resource_id`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `itineraries` ADD CONSTRAINT `itineraries_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `itinerary_versions` ADD CONSTRAINT `itinerary_versions_itinerary_id_fkey` FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `itinerary_items` ADD CONSTRAINT `itinerary_items_itinerary_id_fkey` FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `itinerary_items` ADD CONSTRAINT `itinerary_items_resource_id_fkey` FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `import_errors` ADD CONSTRAINT `import_errors_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ab_allocations` ADD CONSTRAINT `ab_allocations_model_id_fkey` FOREIGN KEY (`model_id`) REFERENCES `ml_models`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `notification_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `outbox_messages` ADD CONSTRAINT `outbox_messages_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_notification_settings` ADD CONSTRAINT `user_notification_settings_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
