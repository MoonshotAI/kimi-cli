#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

API_PORT="${API_PORT:-5494}"
API_URL="http://127.0.0.1:${API_PORT}/openapi.json"

echo "Fetching OpenAPI spec from $API_URL..."
if ! curl -sf -o openapi.json "$API_URL"; then
    echo "Error: Failed to fetch OpenAPI spec. Is the backend running on port $API_PORT?"
    echo "Start it with: uv run ikimi web --port $API_PORT"
    exit 1
fi

echo "Removing old API client..."
rm -rf src/lib/api

echo "Generating TypeScript client..."

# Check if docker is available
if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed"
    exit 1
fi

# Try docker without sudo first, fall back to sudo if needed
DOCKER_CMD="docker"
if ! docker info &> /dev/null; then
    if sudo docker info &> /dev/null; then
        DOCKER_CMD="sudo docker"
        echo "Note: Using sudo for docker"
    else
        echo "Error: Cannot access docker. Make sure docker is running and you have permissions."
        exit 1
    fi
fi

$DOCKER_CMD run --rm \
    -v "$PROJECT_DIR:/local" \
    --network host \
    openapitools/openapi-generator-cli:v7.17.0 generate \
    -i /local/openapi.json \
    -g typescript-fetch \
    -o /local/src/lib/api \
    --additional-properties=supportsES6=true,npmVersion=10.9.0,typescriptThreePlus=true

# Fix ownership if docker created files as root
if [ -n "$(find src/lib/api -user root 2>/dev/null)" ]; then
    echo "Fixing file ownership..."
    sudo chown -R "$(whoami)" src/lib/api
fi

echo "Formatting generated code..."
bun run format

echo "Done! API client generated successfully."
