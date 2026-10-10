#!/bin/sh
# Idempotent store bootstrap, run by the Helm post-install/post-upgrade Job.
# Every step checks current state first, so re-running it (on every
# `helm upgrade`, or after a crash half way through) converges to the same
# store instead of failing or duplicating things.
#
# Secrets (admin password, API key) arrive as env vars from k8s Secrets and
# are never passed as command-line arguments, so they don't show up in `ps`.
set -eu

cd /var/www/html
log() { echo "[bootstrap] $*"; }
wpu() { wp --user="$ADMIN_USER" "$@"; }

# 1. Wait for the WordPress container to copy core files and write
#    wp-config.php onto the shared volume.
i=0
until [ -f wp-config.php ]; do
  i=$((i + 1))
  [ "$i" -gt 120 ] && { log "wp-config.php never appeared"; exit 1; }
  log "waiting for wp-config.php..."
  sleep 5
done

# 2. Wait for MySQL. Uses PHP's mysqli (what WordPress itself uses) rather
#    than the mysql CLI client.
i=0
until php -r 'mysqli_report(MYSQLI_REPORT_OFF); exit(@mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")) ? 0 : 1);'; do
  i=$((i + 1))
  [ "$i" -gt 120 ] && { log "database never became reachable"; exit 1; }
  log "waiting for database..."
  sleep 5
done

# 3. Core install. The admin password is set (and kept in sync with the
#    Secret) by set-admin.php instead of --admin_password on the command line.
if wp core is-installed 2>/dev/null; then
  log "WordPress already installed"
else
  log "installing WordPress"
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_email="$ADMIN_EMAIL" --skip-email >/dev/null
fi
wp eval-file /bootstrap/set-admin.php
wp option update siteurl "$SITE_URL" >/dev/null
wp option update home "$SITE_URL" >/dev/null
wp rewrite structure '/%postname%/' >/dev/null

# 4. WooCommerce plugin, pinned to an exact version.
current=$(wp plugin get woocommerce --field=version 2>/dev/null || true)
if [ "$current" != "$WOOCOMMERCE_VERSION" ]; then
  log "installing WooCommerce $WOOCOMMERCE_VERSION (found: ${current:-none})"
  wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

# 5. Store settings.
wp option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
wp option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
# WooCommerce 9+ starts new stores in "coming soon" mode, which hides the
# storefront from logged-out visitors.
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
wp option update woocommerce_enable_guest_checkout yes >/dev/null
wp option update woocommerce_calc_taxes no >/dev/null
# Skip the onboarding wizard in wp-admin.
wp option update woocommerce_task_list_hidden yes >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
# Cash on delivery: the test-friendly payment method the brief allows.
wp option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json >/dev/null

# 6. Shop / cart / checkout / my-account pages (only creates missing ones).
wpu wc tool run install_pages >/dev/null

# 7. Free shipping everywhere, so any physical product (including ones the
#    chat agent creates) can be checked out without configuring zones.
#    Zone 0 is WooCommerce's built-in "rest of the world" zone.
if [ "$(wpu wc shipping_zone_method list 0 --format=count)" = "0" ]; then
  log "adding free shipping method"
  wpu wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true >/dev/null
fi

# 8. Demo products, keyed by SKU so they're created once.
if [ "$SEED_PRODUCTS" = "true" ]; then
  seed() {
    if [ "$(wpu wc product list --sku="$1" --format=count)" = "0" ]; then
      log "seeding product $1"
      wpu wc product create --sku="$1" --name="$2" --regular_price="$3" \
        --description="$4" --status=publish >/dev/null
    fi
  }
  seed DEMO-MUG "Urumi Coffee Mug" 12.00 "A ceramic mug for long debugging sessions."
  seed DEMO-TEE "Kubernetes T-Shirt" 25.00 "Cotton tee with a tiny helm wheel."
  seed DEMO-STICKERS "MCP Sticker Pack" 5.00 "Ten vinyl stickers for your laptop."
fi

# 9. Register the REST API key from the Secret into WooCommerce.
wp eval-file /bootstrap/register-api-key.php

log "done"
