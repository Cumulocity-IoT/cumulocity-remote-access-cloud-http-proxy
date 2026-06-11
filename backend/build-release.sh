#!/usr/bin/env bash
# Builds the microservice Docker image and packages it together with cumulocity.json into the
# cloud-http-proxy.zip artifact expected by the Cumulocity microservice uploader. Replaces the
# former `build:release` npm script.
set -euo pipefail

# Run from the backend directory regardless of where the script was invoked from.
cd "$(dirname "$0")"

# Build context is the repository root so the Dockerfile can reach backend/.
docker build -t cloud-http-proxy -f ./Dockerfile ..
docker save cloud-http-proxy -o image.tar
zip ../cloud-http-proxy cumulocity.json image.tar
