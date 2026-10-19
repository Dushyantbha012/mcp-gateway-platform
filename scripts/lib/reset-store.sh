#!/bin/sh
# Runs INSIDE a one-off Job pod created by scripts/reset-demo.sh (a copy of the
# store's bootstrap Job: same image, volume, env and NetworkPolicy labels).
# Deletes every WooCommerce order and product, then re-runs the normal
# bootstrap script, which re-seeds the demo products and converges settings.
set -eu
cd /var/www/html
wpu() { wp --user="$ADMIN_USER" "$@"; }

# A new pod is refused by the NetworkPolicy for a few seconds, so wait for MySQL
# the way bootstrap.sh does before touching WordPress.
i=0
until php -r 'mysqli_report(MYSQLI_REPORT_OFF); exit(@mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")) ? 0 : 1);'; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "[reset] database never became reachable"; exit 1; }
  sleep 2
done

echo "[reset] deleting orders"
for id in $(wpu wc shop_order list --field=id --per_page=100 --status=any); do
  wpu wc shop_order delete "$id" --force=true >/dev/null
done
echo "[reset] deleting products"
ids=$(wp post list --post_type=product,product_variation --post_status=any --format=ids)
[ -z "$ids" ] || wp post delete $ids --force >/dev/null
echo "[reset] re-seeding"
sh /bootstrap/bootstrap.sh
