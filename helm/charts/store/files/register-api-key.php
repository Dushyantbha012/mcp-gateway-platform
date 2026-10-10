<?php
// Registers the WooCommerce REST API key from the store-wc-api Secret.
//
// The Secret is the source of truth: WooCommerce stores the consumer key only
// as an HMAC hash (wc_api_hash) and the secret in plain text - the same thing
// its own "Add key" screen does. If the Secret is rotated, the old managed
// key row is replaced, so a stale key stops working.
global $wpdb;

$description = 'mcp-gateway (managed by Helm bootstrap)';
$table = $wpdb->prefix . 'woocommerce_api_keys';
$consumer_key = getenv('WC_CONSUMER_KEY');
$consumer_secret = getenv('WC_CONSUMER_SECRET');
$user = get_user_by('login', getenv('ADMIN_USER'));

if (!$consumer_key || !$consumer_secret || !$user) {
    WP_CLI::error('missing WC_CONSUMER_KEY, WC_CONSUMER_SECRET or admin user');
}

$hash = wc_api_hash($consumer_key);
$existing = $wpdb->get_row($wpdb->prepare(
    "SELECT key_id, consumer_secret FROM {$table} WHERE consumer_key = %s",
    $hash
));

if ($existing && hash_equals($existing->consumer_secret, $consumer_secret)) {
    WP_CLI::log('[bootstrap] REST API key already registered');
    return;
}

$wpdb->delete($table, ['description' => $description]);
$wpdb->delete($table, ['consumer_key' => $hash]);
$ok = $wpdb->insert($table, [
    'user_id' => $user->ID,
    'description' => $description,
    'permissions' => 'read_write',
    'consumer_key' => $hash,
    'consumer_secret' => $consumer_secret,
    'truncated_key' => substr($consumer_key, -7),
]);
if (!$ok) {
    WP_CLI::error('failed to insert API key: ' . $wpdb->last_error);
}
WP_CLI::log('[bootstrap] REST API key registered');
