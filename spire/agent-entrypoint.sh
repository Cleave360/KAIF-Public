#!/bin/sh
set -e
TOKEN=$(cat /run/spire/token/join_token)
rm -f /run/spire/sockets/agent.sock
exec /opt/spire/bin/spire-agent run \
  -config /opt/spire/conf/agent/agent.conf \
  -joinToken "${TOKEN}"
