#!/usr/bin/env bash
# Generates an RSA-2048 keypair for KAIF server JWT signing.
# Output: keys/private.pem, keys/public.pem
#
# Only needed when NOT using ephemeral keys.
# Leave KAIF_PRIVATE_KEY_PATH unset to generate an ephemeral key at startup.

set -euo pipefail

mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
chmod 600 keys/private.pem

echo "Keys written to keys/private.pem and keys/public.pem"
echo "Add to .env:  KAIF_PRIVATE_KEY_PATH=./keys/private.pem"
