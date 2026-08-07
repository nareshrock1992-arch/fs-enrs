#!/bin/sh
# Docker entrypoint for the fs-enrs backend container.
#
# Runs database migrations (idempotent) before starting the application.
# This resolves the bootstrap deadlock: the backend's validateSchema() call
# would exit(1) on a fresh database; running migrate.js here ensures tables
# exist before server.js is ever executed.
#
# Migration behaviour:
#   Fresh database  — applies schema.sql then all numbered migration files.
#   Existing database — skips already-applied migrations; applies only new ones.
#
# If migrate.js exits non-zero (SQL error, connection failure) this script
# also exits non-zero and the container does NOT start. Docker's restart
# policy will retry the whole sequence — correct behaviour for a transient
# DB connection failure at startup.
set -e

echo "[entrypoint] Running database migrations ..."
node src/db/migrate.js

echo "[entrypoint] Migrations complete. Starting server ..."
exec "$@"
