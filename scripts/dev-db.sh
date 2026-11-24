#!/usr/bin/env bash
# Throwaway Postgres for local development and SQL tests. Data lives only in the container.
#   scripts/dev-db.sh up      start and apply every migration
#   scripts/dev-db.sh psql    open a psql shell
#   scripts/dev-db.sh down    remove the container
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=aksis-ai-dev-postgres
PORT=${AKSIS_DEV_DB_PORT:-15432}

case "${1:-up}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" \
      -e POSTGRES_USER=aksis_ai -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=aksis_ai \
      postgres:16-alpine >/dev/null
    # The init-time server listens on the socket only; TCP answers once the real server is up.
    until docker exec "$NAME" pg_isready -h 127.0.0.1 -U aksis_ai -d aksis_ai >/dev/null 2>&1; do sleep 1; done
    for file in migrations/*.sql; do
      docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U aksis_ai -d aksis_ai < "$file"
    done
    echo "DATABASE_URL=postgres://aksis_ai:dev@127.0.0.1:$PORT/aksis_ai"
    ;;
  psql) exec docker exec -it "$NAME" psql -U aksis_ai -d aksis_ai ;;
  down) docker rm -f "$NAME" ;;
  *) echo "usage: $0 up|psql|down" >&2; exit 2 ;;
esac
