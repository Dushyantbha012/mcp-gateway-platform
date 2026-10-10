<?php
// Keeps the admin account's password equal to the store-admin Secret.
// Only writes when it differs, so re-runs don't log the admin out.
$user = get_user_by('login', getenv('ADMIN_USER'));
if (!$user) {
    WP_CLI::error('admin user ' . getenv('ADMIN_USER') . ' not found');
}
$password = getenv('ADMIN_PASSWORD');
if (!wp_check_password($password, $user->user_pass, $user->ID)) {
    wp_set_password($password, $user->ID);
    WP_CLI::log('[bootstrap] admin password synced from Secret');
}
