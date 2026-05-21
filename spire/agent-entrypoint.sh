#!/bin/sh
set -e
TOKEN=$(cat /run/spire/token/join_token)
exec /opt/spire/bin/spire-agent run \
  -config /opt/spire/conf/agent/agent.conf \
  -joinToken "${TOKEN}"
