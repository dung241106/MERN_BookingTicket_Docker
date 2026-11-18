#!/usr/bin/env bash
# Verifies the built frontend contains no secrets and no stale API URLs.
# Usage: ./scripts/check-bundle-secrets.sh [IMAGE]   default: quickshow-docker-web
# Run after: sudo docker compose build web   (use sudo if your user is not in the docker group)
set -u
IMAGE="${1:-quickshow-docker-web}"
DIR=/usr/share/nginx/html

echo "== Forbidden patterns (must find NOTHING) =="
if docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -rEo 'sk_(test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|localhost:3000|vercel\.app' $DIR" | sort -u | grep .; then
  echo "FAIL: forbidden pattern found above (rebuild with VITE_BASE_URL=/ and remove secrets)"; exit 1
else
  echo "PASS: no secret keys / localhost:3000 / vercel.app in bundle"
fi

echo
echo "== Expected (publishable key only) =="
docker run --rm --entrypoint sh "$IMAGE" -c "grep -rEo 'pk_(test|live)_' $DIR | sort -u" \
  | sed 's/$/  <- publishable key is allowed/'
