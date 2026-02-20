#!/bin/bash
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Build Lambda layers for Terraform deployment
#
# Usage: ./iac-terraform/scripts/build-layers.sh [--architecture arm64|x86_64] [--force]
#
# Architecture is auto-detected from terraform.tfvars if not specified.
# Uses checksum-based caching to skip builds when sources haven't changed.
#
# This script builds:
# 1. boto3-layer.zip - Latest boto3/botocore
# 2. genai-core-layer.zip - Shared GenAI Core Python SDK

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/iac-terraform"
BUILD_DIR="${TERRAFORM_DIR}/build"
PYTHON_VERSION="3.14"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo_skip() {
    echo -e "${BLUE}[SKIP]${NC} $1"
}

# -----------------------------------------------------------------------------
# Auto-detect architecture from Terraform configuration
# Priority: CLI argument > terraform.tfvars > default (arm64)
# -----------------------------------------------------------------------------
get_architecture_from_config() {
    local tfvars="${TERRAFORM_DIR}/terraform.tfvars"

    # Check terraform.tfvars
    if [[ -f "$tfvars" ]]; then
        local arch
        arch=$(grep -E '^\s*lambda_architecture\s*=' "$tfvars" 2>/dev/null | sed 's/.*=\s*"\([^"]*\)".*/\1/' | tr -d '[:space:]')
        if [[ -n "$arch" && ("$arch" == "arm64" || "$arch" == "x86_64") ]]; then
            echo "$arch"
            return
        fi
    fi

    # Default from variables.tf
    echo "arm64"
}

# -----------------------------------------------------------------------------
# Compute checksum for a file or directory
# -----------------------------------------------------------------------------
compute_checksum() {
    local path="$1"
    if [[ -d "$path" ]]; then
        # For directories, hash all files recursively
        find "$path" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1
    else
        # For single files
        shasum -a 256 "$path" | cut -d' ' -f1
    fi
}

# -----------------------------------------------------------------------------
# Check if rebuild is needed based on checksum
# Returns 0 if rebuild needed, 1 if up-to-date
# -----------------------------------------------------------------------------
needs_rebuild() {
    local source_path="$1"
    local zip_file="$2"
    local hash_file="$3"
    local architecture="$4"

    # Always rebuild if zip doesn't exist
    if [[ ! -f "$zip_file" ]]; then
        return 0
    fi

    # Always rebuild if hash file doesn't exist
    if [[ ! -f "$hash_file" ]]; then
        return 0
    fi

    # Compute current hash (include architecture in hash)
    local current_hash
    current_hash="${architecture}:$(compute_checksum "$source_path")"

    # Compare with stored hash
    local stored_hash
    stored_hash=$(cat "$hash_file" 2>/dev/null || echo "")

    if [[ "$current_hash" == "$stored_hash" ]]; then
        return 1  # Up-to-date
    else
        return 0  # Needs rebuild
    fi
}

# -----------------------------------------------------------------------------
# Save checksum after successful build
# -----------------------------------------------------------------------------
save_checksum() {
    local source_path="$1"
    local hash_file="$2"
    local architecture="$3"

    local hash="${architecture}:$(compute_checksum "$source_path")"
    echo "$hash" > "$hash_file"
}

# Initialize variables
ARCHITECTURE=""
FORCE_REBUILD=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --architecture|-a)
            ARCHITECTURE="$2"
            shift 2
            ;;
        --force|-f)
            FORCE_REBUILD=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--architecture arm64|x86_64] [--force]"
            echo ""
            echo "Options:"
            echo "  --architecture, -a   Lambda architecture (arm64 or x86_64)"
            echo "                       If not specified, reads from terraform.tfvars"
            echo "                       Default: arm64"
            echo "  --force, -f          Force rebuild even if sources haven't changed"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# If not set via CLI, auto-detect from config
if [[ -z "$ARCHITECTURE" ]]; then
    ARCHITECTURE=$(get_architecture_from_config)
    echo_info "Auto-detected architecture from config: ${ARCHITECTURE}"
else
    echo_info "Using architecture from CLI: ${ARCHITECTURE}"
fi

# Validate architecture
if [[ "${ARCHITECTURE}" != "arm64" && "${ARCHITECTURE}" != "x86_64" ]]; then
    echo_error "Invalid architecture: ${ARCHITECTURE}. Must be 'arm64' or 'x86_64'."
    exit 1
fi

echo_info "Building Lambda layers for architecture: ${ARCHITECTURE}"
echo_info "Python version: ${PYTHON_VERSION}"
echo_info "Build directory: ${BUILD_DIR}"

if [[ "$FORCE_REBUILD" == "true" ]]; then
    echo_warn "Force rebuild enabled - ignoring cache"
fi

# Create build directory
mkdir -p "${BUILD_DIR}"

# Determine Docker platform
if [[ "${ARCHITECTURE}" == "arm64" ]]; then
    DOCKER_PLATFORM="linux/arm64"
else
    DOCKER_PLATFORM="linux/amd64"
fi

# -----------------------------------------------------------------------------
# Build boto3 Layer
# -----------------------------------------------------------------------------
BOTO3_LAYER_DIR="${PROJECT_ROOT}/lib/shared/layers/boto3-latest"
BOTO3_ZIP="${BUILD_DIR}/boto3-layer.zip"
BOTO3_HASH_FILE="${BUILD_DIR}/.boto3-layer.hash"

if [[ "$FORCE_REBUILD" == "false" ]] && ! needs_rebuild "${BOTO3_LAYER_DIR}/requirements.txt" "$BOTO3_ZIP" "$BOTO3_HASH_FILE" "$ARCHITECTURE"; then
    echo_skip "boto3 layer is up-to-date (source unchanged)"
else
    echo_info "Building boto3 layer..."

    # Use a temp dir within build (Docker on macOS has issues with /var/folders)
    BOTO3_TEMP_DIR="${BUILD_DIR}/.boto3-temp"
    rm -rf "${BOTO3_TEMP_DIR}"
    mkdir -p "${BOTO3_TEMP_DIR}"

    # Check if Docker is available
    if command -v docker &> /dev/null; then
        echo_info "Using Docker to build boto3 layer..."

        docker run --rm \
            --platform "${DOCKER_PLATFORM}" \
            --entrypoint bash \
            -v "${BOTO3_LAYER_DIR}:/app:ro" \
            -v "${BOTO3_TEMP_DIR}:/output" \
            "public.ecr.aws/lambda/python:${PYTHON_VERSION}" \
            -c "pip install -r /app/requirements.txt -t /output/python --root-user-action=ignore && \
                find /output -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true && \
                find /output -type f -name '*.pyc' -delete 2>/dev/null || true"
    else
        echo_warn "Docker not available. Using local pip (may have compatibility issues)..."

        pip install -r "${BOTO3_LAYER_DIR}/requirements.txt" \
            -t "${BOTO3_TEMP_DIR}/python" \
            --quiet \
            --platform "manylinux2014_${ARCHITECTURE}" \
            --only-binary=:all: \
            --python-version "${PYTHON_VERSION}" || \
        pip install -r "${BOTO3_LAYER_DIR}/requirements.txt" \
            -t "${BOTO3_TEMP_DIR}/python" \
            --quiet
    fi

    # Verify files were created
    if [[ ! -d "${BOTO3_TEMP_DIR}/python" ]] || [[ -z "$(ls -A "${BOTO3_TEMP_DIR}/python" 2>/dev/null)" ]]; then
        echo_error "Failed to install boto3 dependencies. Check Docker volume mounting."
        rm -rf "${BOTO3_TEMP_DIR}"
        exit 1
    fi

    # Create zip
    rm -f "${BOTO3_ZIP}"
    (cd "${BOTO3_TEMP_DIR}" && zip -r "${BOTO3_ZIP}" python -q)
    rm -rf "${BOTO3_TEMP_DIR}"

    # Save checksum for future comparisons
    save_checksum "${BOTO3_LAYER_DIR}/requirements.txt" "$BOTO3_HASH_FILE" "$ARCHITECTURE"

    echo_info "Created: ${BOTO3_ZIP}"
fi

# -----------------------------------------------------------------------------
# Build GenAI Core Layer
# -----------------------------------------------------------------------------
GENAI_CORE_DIR="${PROJECT_ROOT}/lib/shared/layers/python-sdk"
GENAI_CORE_ZIP="${BUILD_DIR}/genai-core-layer.zip"
GENAI_CORE_HASH_FILE="${BUILD_DIR}/.genai-core-layer.hash"

if [[ "$FORCE_REBUILD" == "false" ]] && ! needs_rebuild "${GENAI_CORE_DIR}/genai_core" "$GENAI_CORE_ZIP" "$GENAI_CORE_HASH_FILE" "$ARCHITECTURE"; then
    echo_skip "GenAI Core layer is up-to-date (source unchanged)"
else
    echo_info "Building GenAI Core layer..."

    GENAI_CORE_TEMP_DIR="${BUILD_DIR}/.genai-core-temp"
    rm -rf "${GENAI_CORE_TEMP_DIR}"

    # Lambda layers expect Python packages in a 'python' directory
    mkdir -p "${GENAI_CORE_TEMP_DIR}/python"
    cp -r "${GENAI_CORE_DIR}/genai_core" "${GENAI_CORE_TEMP_DIR}/python/"

    # Remove __pycache__ directories
    find "${GENAI_CORE_TEMP_DIR}" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
    find "${GENAI_CORE_TEMP_DIR}" -type f -name '*.pyc' -delete 2>/dev/null || true

    # Create zip
    rm -f "${GENAI_CORE_ZIP}"
    (cd "${GENAI_CORE_TEMP_DIR}" && zip -r "${GENAI_CORE_ZIP}" python -q)
    rm -rf "${GENAI_CORE_TEMP_DIR}"

    # Save checksum for future comparisons
    save_checksum "${GENAI_CORE_DIR}/genai_core" "$GENAI_CORE_HASH_FILE" "$ARCHITECTURE"

    echo_info "Created: ${GENAI_CORE_ZIP}"
fi

# -----------------------------------------------------------------------------
# Build TypeScript Lambda Functions
# Uses esbuild to compile TypeScript to JavaScript
# -----------------------------------------------------------------------------
NOTIFY_RUNTIME_UPDATE_DIR="${PROJECT_ROOT}/lib/api/functions/notify-runtime-update"
NOTIFY_RUNTIME_UPDATE_OUT="${BUILD_DIR}/notify-runtime-update"
NOTIFY_RUNTIME_UPDATE_HASH_FILE="${BUILD_DIR}/.notify-runtime-update.hash"

if [[ "$FORCE_REBUILD" == "false" ]] && ! needs_rebuild "${NOTIFY_RUNTIME_UPDATE_DIR}/index.ts" "${NOTIFY_RUNTIME_UPDATE_OUT}/index.js" "$NOTIFY_RUNTIME_UPDATE_HASH_FILE" "$ARCHITECTURE"; then
    echo_skip "notify-runtime-update Lambda is up-to-date (source unchanged)"
else
    echo_info "Building notify-runtime-update Lambda (TypeScript)..."

    # Check if npx/esbuild is available
    if ! command -v npx &> /dev/null; then
        echo_error "npx not found. Please install Node.js to build TypeScript Lambdas."
        exit 1
    fi

    # Create output directory
    rm -rf "${NOTIFY_RUNTIME_UPDATE_OUT}"
    mkdir -p "${NOTIFY_RUNTIME_UPDATE_OUT}"

    # Bundle TypeScript with esbuild
    npx esbuild "${NOTIFY_RUNTIME_UPDATE_DIR}/index.ts" \
        --bundle \
        --platform=node \
        --target=node22 \
        --outfile="${NOTIFY_RUNTIME_UPDATE_OUT}/index.js" \
        --external:@aws-sdk/* \
        --external:@aws-lambda-powertools/*

    # Save checksum for future comparisons
    save_checksum "${NOTIFY_RUNTIME_UPDATE_DIR}/index.ts" "$NOTIFY_RUNTIME_UPDATE_HASH_FILE" "$ARCHITECTURE"

    echo_info "Created: ${NOTIFY_RUNTIME_UPDATE_OUT}/index.js"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo_info "Build complete!"
echo ""
echo "Layer files:"
ls -lh "${BUILD_DIR}"/*.zip 2>/dev/null || echo "  (no zip files found)"
echo ""
echo "To deploy with Terraform:"
echo "  make tf-deploy"
echo ""
echo "To force rebuild:"
echo "  ./iac-terraform/scripts/build-layers.sh --force"
