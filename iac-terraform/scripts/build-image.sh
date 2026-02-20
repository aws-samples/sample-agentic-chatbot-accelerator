#!/bin/bash
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Build and push AgentCore Docker image to ECR
#
# Usage: ./iac-terraform/scripts/build-image.sh [--profile PROFILE] [--region REGION] [--tag TAG]
#
# This script:
# 1. Gets the ECR repository URL from Terraform outputs
# 2. Authenticates Docker to ECR
# 3. Builds the AgentCore container image
# 4. Pushes to ECR with the specified tag

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TERRAFORM_DIR="${PROJECT_ROOT}/iac-terraform"
DOCKER_DIR="${PROJECT_ROOT}/lib/agent-core/docker"

# Defaults
AWS_PROFILE=""
AWS_REGION=""
IMAGE_TAG=""
PLATFORM="linux/arm64"

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
# Auto-detect settings from Terraform configuration
# -----------------------------------------------------------------------------
get_from_tfvars() {
    local key="$1"
    local tfvars="${TERRAFORM_DIR}/terraform.tfvars"

    if [[ -f "$tfvars" ]]; then
        # Extract value from: key = "value"
        grep -E "^[[:space:]]*${key}[[:space:]]*=" "$tfvars" 2>/dev/null | \
            head -1 | \
            sed -E 's/^[^"]*"([^"]*)".*$/\1/'
    fi
}

get_architecture_from_config() {
    local arch
    arch=$(get_from_tfvars "lambda_architecture")
    if [[ -n "$arch" ]]; then
        echo "$arch"
    else
        echo "arm64"  # Default
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --profile|-p)
            AWS_PROFILE="$2"
            shift 2
            ;;
        --region|-r)
            AWS_REGION="$2"
            shift 2
            ;;
        --tag|-t)
            IMAGE_TAG="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--profile PROFILE] [--region REGION] [--tag TAG]"
            echo ""
            echo "Options:"
            echo "  --profile, -p    AWS profile for authentication"
            echo "  --region, -r     AWS region (default: from terraform.tfvars or us-east-1)"
            echo "  --tag, -t        Docker image tag (default: latest)"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Auto-detect from terraform.tfvars if not provided
if [[ -z "$AWS_PROFILE" ]]; then
    AWS_PROFILE=$(get_from_tfvars "aws_profile")
fi

if [[ -z "$AWS_REGION" ]]; then
    AWS_REGION=$(get_from_tfvars "aws_region")
    AWS_REGION="${AWS_REGION:-us-east-1}"
fi

# Compute content-based image tag from Docker source files (matches Terraform ecr.tf logic)
# This ensures the tag used here matches what Terraform expects
compute_content_tag() {
    local docker_dir="${PROJECT_ROOT}/lib/agent-core/docker"

    if [[ ! -d "$docker_dir" ]]; then
        echo ""
        return
    fi

    # Compute hash of Docker source files (same files as Terraform's docker_source_hash)
    local hash_input=""
    hash_input+=$(shasum -a 256 "${docker_dir}/Dockerfile" 2>/dev/null | cut -d' ' -f1)
    hash_input+=$(shasum -a 256 "${docker_dir}/requirements.txt" 2>/dev/null | cut -d' ' -f1)
    hash_input+=$(shasum -a 256 "${docker_dir}/app.py" 2>/dev/null | cut -d' ' -f1)
    # Hash all src/ files (sorted for consistency, matching Terraform's sort())
    hash_input+=$(find "${docker_dir}/src" -type f | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1)

    # Final hash of all hashes, take first 12 chars (matches Terraform's substr(..., 0, 12))
    echo -n "$hash_input" | shasum -a 256 | cut -c1-12
}

# Determine image tag: CLI flag > Terraform output > content hash > "latest" fallback
if [[ -z "$IMAGE_TAG" ]]; then
    # Try to get the tag from Terraform output (most accurate, matches exactly)
    cd "${TERRAFORM_DIR}"
    TF_TAG=$(terraform output -raw docker_image_tag 2>/dev/null || echo "")
    cd - > /dev/null

    if [[ -n "$TF_TAG" ]]; then
        IMAGE_TAG="$TF_TAG"
        echo_info "Using image tag from Terraform output: ${IMAGE_TAG}"
    else
        # Compute content-based tag locally (fallback if Terraform not initialized)
        CONTENT_TAG=$(compute_content_tag)
        if [[ -n "$CONTENT_TAG" ]]; then
            IMAGE_TAG="$CONTENT_TAG"
            echo_info "Using content-based image tag: ${IMAGE_TAG}"
        else
            IMAGE_TAG="latest"
            echo_warn "Could not compute content-based tag. Falling back to 'latest'."
        fi
    fi
fi

# Set Docker platform based on architecture
ARCH=$(get_architecture_from_config)
if [[ "$ARCH" == "arm64" ]]; then
    PLATFORM="linux/arm64"
else
    PLATFORM="linux/amd64"
fi

echo_info "AWS Profile: ${AWS_PROFILE:-<default>}"
echo_info "AWS Region: ${AWS_REGION}"
echo_info "Image Tag: ${IMAGE_TAG}"
echo_info "Platform: ${PLATFORM}"

# Build AWS CLI profile flag
PROFILE_FLAG=""
if [[ -n "$AWS_PROFILE" ]]; then
    PROFILE_FLAG="--profile $AWS_PROFILE"
fi

# -----------------------------------------------------------------------------
# Get ECR Repository URL from Terraform
# -----------------------------------------------------------------------------
echo_info "Getting ECR repository URL from Terraform..."

cd "${TERRAFORM_DIR}"

# Check if Terraform state exists and has the ECR output
ECR_STATE=$(terraform state list 2>&1 | grep "aws_ecr_repository" || true)
if [[ -z "$ECR_STATE" ]]; then
    echo_warn "ECR repository not yet created. Run 'terraform apply' first."
    echo_info "Hint: The first deployment creates the ECR repo. This script should run on subsequent deploys."
    exit 0
fi

ECR_REPO_URL=$(terraform output -raw ecr_repository_url 2>/dev/null || echo "")

if [[ -z "$ECR_REPO_URL" ]]; then
    echo_error "Could not get ECR repository URL from Terraform outputs."
    echo_info "Make sure you have run 'terraform apply' at least once."
    exit 1
fi

echo_info "ECR Repository: ${ECR_REPO_URL}"

# Extract registry URL (everything before the repository name)
ECR_REGISTRY="${ECR_REPO_URL%/*}"

# -----------------------------------------------------------------------------
# Authenticate Docker to ECR
# -----------------------------------------------------------------------------
echo_info "Authenticating Docker to ECR..."

aws ecr get-login-password --region "${AWS_REGION}" ${PROFILE_FLAG} | \
    docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# -----------------------------------------------------------------------------
# Build Docker Image
# -----------------------------------------------------------------------------
echo_info "Building Docker image from ${DOCKER_DIR}..."

FULL_IMAGE_URI="${ECR_REPO_URL}:${IMAGE_TAG}"

docker build \
    --platform "${PLATFORM}" \
    -t "${FULL_IMAGE_URI}" \
    "${DOCKER_DIR}"

echo_info "Built: ${FULL_IMAGE_URI}"

# -----------------------------------------------------------------------------
# Push to ECR
# -----------------------------------------------------------------------------
echo_info "Pushing image to ECR..."

docker push "${FULL_IMAGE_URI}"

echo ""
echo_info "✅ Image pushed successfully!"
echo ""
echo "Image URI: ${FULL_IMAGE_URI}"
echo ""
echo "You can now deploy the AgentCore Runtime:"
echo "  make tf-deploy"
