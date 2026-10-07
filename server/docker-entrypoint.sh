#!/bin/sh
set -e

echo "Running prisma migrate deploy..."
npx prisma migrate deploy

echo "Starting server..."
exec node dist/index.js
