#!/bin/sh
set -eu
# The host-published admin port must not be reachable from user scripts.
# Other network destinations/ports remain available to the execution sandbox.
port="${BOT_WEB_PORT:-8765}"
case "$port" in *[!0-9]*|'') echo 'invalid management port' >&2; exit 1;; esac
for network in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -A OUTPUT -p tcp -d "$network" --dport "$port" -j REJECT
done
exec setpriv --reuid=65534 --regid=65534 --clear-groups python -I -u /runner/server.py
