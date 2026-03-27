#!/bin/bash
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Pre-deploy build script for CDK — triggers CodeBuild builds and waits.
#
# Usage:
#   ./iac-cdk/scripts/build.sh [--stack-name NAME] [--region REGION] [--profile PROFILE]
#
# The script:
#  1. Lists all CodeBuild projects matching the builder stack prefix
#  2. For each project, compares the current source config vs last successful build
#  3. Skips builds where nothing changed (same source S3 path)
#  4. Starts changed builds in parallel, polls until complete
#  5. Exits 0 on success, 1 on any failure
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
STACK_NAME="${CDK_STACK_NAME:-}"
AWS_REGION="${AWS_DEFAULT_REGION:-}"
AWS_PROFILE_FLAG=""
POLL_INTERVAL=10       # seconds between status checks
MAX_WAIT=1800          # 30 minutes max per build

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
skip()  { echo -e "${BLUE}[SKIP]${NC}  $*"; }

# ── Parse CLI args ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --stack-name|-s) STACK_NAME="$2"; shift 2 ;;
        --region|-r)     AWS_REGION="$2"; shift 2 ;;
        --profile|-p)    AWS_PROFILE_FLAG="--profile $2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--stack-name NAME] [--region REGION] [--profile PROFILE]"
            exit 0 ;;
        *) shift ;;
    esac
done

# Require stack name — auto-detect from config.yaml if not provided
if [[ -z "$STACK_NAME" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
    CONFIG_YAML="${CDK_DIR}/bin/config.yaml"

    if [[ -f "$CONFIG_YAML" ]]; then
        PREFIX=$(grep -E '^\s*prefix\s*:' "$CONFIG_YAML" | head -1 | sed 's/^[^:]*:\s*//' | tr -d '[:space:]' | tr -d '"' | tr -d "'")
        if [[ -n "$PREFIX" ]]; then
            STACK_NAME="${PREFIX}-aca-builder"
            info "Auto-detected builder stack name from config.yaml: ${STACK_NAME}"
        fi
    fi

    if [[ -z "$STACK_NAME" ]]; then
        err "Stack name required. Use --stack-name or set CDK_STACK_NAME."
        err "Alternatively, set 'prefix' in iac-cdk/bin/config.yaml."
        exit 1
    fi
fi

REGION_FLAG=""
if [[ -n "$AWS_REGION" ]]; then
    REGION_FLAG="--region $AWS_REGION"
fi

# ── Discover CodeBuild projects for this stack ────────────────────────────────
info "Discovering CodeBuild projects for stack: ${STACK_NAME}..."
STACK_LOWER=$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')

PROJECTS=$(aws codebuild list-projects $AWS_PROFILE_FLAG $REGION_FLAG --query "projects" --output json 2>/dev/null | \
    jq -r ".[] | select(startswith(\"${STACK_LOWER}-\") and endswith(\"-builder\"))" 2>/dev/null || echo "")

if [[ -z "$PROJECTS" ]]; then
    skip "No CodeBuild projects found for stack '${STACK_NAME}'. First deploy — BuilderStack will create them."
    exit 0
fi

PROJECT_COUNT=$(echo "$PROJECTS" | wc -l | tr -d ' ')
info "Found ${PROJECT_COUNT} build project(s)"

# ── Check which projects need rebuilds ────────────────────────────────────────
# For each project:
#   1. Get the project's CURRENT source S3 location (set by CDK in Phase 1)
#   2. Get the LAST build's source S3 location
#   3. If they match and last build succeeded → skip (nothing changed)
#   4. If they differ, no previous build, or last build failed → rebuild

needs_rebuild() {
    local project="$1"

    # Get current project source config (bucket + path set by CDK)
    local current_source
    current_source=$(aws codebuild batch-get-projects \
        --names "$project" \
        $AWS_PROFILE_FLAG $REGION_FLAG \
        --query 'projects[0].source.location' \
        --output text 2>/dev/null || echo "")

    if [[ -z "$current_source" || "$current_source" == "None" ]]; then
        return 0  # No source config — needs build
    fi

    # Get last build for this project
    local last_build_id
    last_build_id=$(aws codebuild list-builds-for-project \
        --project-name "$project" \
        --sort-order DESCENDING \
        $AWS_PROFILE_FLAG $REGION_FLAG \
        --query 'ids[0]' \
        --output text 2>/dev/null || echo "")

    if [[ -z "$last_build_id" || "$last_build_id" == "None" ]]; then
        return 0  # No previous builds — needs build
    fi

    # Get last build's status and source location
    local last_build_info
    last_build_info=$(aws codebuild batch-get-builds \
        --ids "$last_build_id" \
        $AWS_PROFILE_FLAG $REGION_FLAG \
        --query 'builds[0].[buildStatus,source.location]' \
        --output json 2>/dev/null || echo "[]")

    local last_status
    last_status=$(echo "$last_build_info" | jq -r '.[0]' 2>/dev/null || echo "")
    local last_source
    last_source=$(echo "$last_build_info" | jq -r '.[1]' 2>/dev/null || echo "")

    # Skip only if last build succeeded AND source hasn't changed
    if [[ "$last_status" == "SUCCEEDED" && "$current_source" == "$last_source" ]]; then
        return 1  # No rebuild needed
    fi

    return 0  # Needs rebuild
}

# ── Start builds only for changed projects ────────────────────────────────────
BUILD_IDS=()
BUILD_PROJECTS=()
SKIPPED=0

for PROJECT in $PROJECTS; do
    if needs_rebuild "$PROJECT"; then
        info "Starting build: ${PROJECT}"

        BUILD_RESULT=$(aws codebuild start-build \
            --project-name "$PROJECT" \
            $AWS_PROFILE_FLAG $REGION_FLAG \
            --query 'build.id' --output text 2>&1) || {
            err "Failed to start build for ${PROJECT}: ${BUILD_RESULT}"
            exit 1
        }

        BUILD_IDS+=("$BUILD_RESULT")
        BUILD_PROJECTS+=("$PROJECT")
        info "  → Build ID: ${BUILD_RESULT}"
    else
        skip "Already built (unchanged): ${PROJECT}"
        SKIPPED=$((SKIPPED + 1))
    fi
done

TOTAL=${#BUILD_IDS[@]}

if [[ $TOTAL -eq 0 ]]; then
    info "✅ All ${SKIPPED} project(s) already up to date — nothing to build!"
    exit 0
fi

info "Building ${TOTAL} project(s), skipped ${SKIPPED} unchanged"
info "Waiting for ${TOTAL} build(s) to complete..."

# ── Helper: look up project name by build ID ──────────────────────────────────
get_project_for_bid() {
    local bid="$1"
    for i in "${!BUILD_IDS[@]}"; do
        if [[ "${BUILD_IDS[$i]}" == "$bid" ]]; then
            echo "${BUILD_PROJECTS[$i]}"
            return
        fi
    done
    echo "unknown"
}

# ── Poll all builds ──────────────────────────────────────────────────────────
COMPLETED_IDS=""
COMPLETED_COUNT=0
ELAPSED=0

while [[ $COMPLETED_COUNT -lt $TOTAL ]]; do
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))

    if [[ $ELAPSED -gt $MAX_WAIT ]]; then
        err "Timeout: builds not completed within ${MAX_WAIT}s"
        exit 1
    fi

    # Collect pending build IDs
    PENDING_IDS=()
    for BID in "${BUILD_IDS[@]}"; do
        if ! echo "$COMPLETED_IDS" | grep -qF "$BID"; then
            PENDING_IDS+=("$BID")
        fi
    done

    if [[ ${#PENDING_IDS[@]} -eq 0 ]]; then
        break
    fi

    # Query all pending builds at once
    STATUSES=$(aws codebuild batch-get-builds \
        --ids "${PENDING_IDS[@]}" \
        $AWS_PROFILE_FLAG $REGION_FLAG \
        --query 'builds[*].[id,buildStatus,currentPhase]' \
        --output json 2>/dev/null)

    # Process each result
    for BID in "${PENDING_IDS[@]}"; do
        BID_STATUS=$(echo "$STATUSES" | jq -r ".[] | select(.[0]==\"$BID\") | .[1]")
        BID_PHASE=$(echo "$STATUSES" | jq -r ".[] | select(.[0]==\"$BID\") | .[2]")
        PROJ=$(get_project_for_bid "$BID")

        case "$BID_STATUS" in
            SUCCEEDED)
                info "  ✅ ${PROJ} — SUCCEEDED (${ELAPSED}s)"
                COMPLETED_IDS="${COMPLETED_IDS}${BID}"$'\n'
                COMPLETED_COUNT=$((COMPLETED_COUNT + 1))
                ;;
            FAILED|FAULT|STOPPED|TIMED_OUT)
                err "  ❌ ${PROJ} — ${BID_STATUS}"
                LOG_URL=$(aws codebuild batch-get-builds --ids "$BID" \
                    $AWS_PROFILE_FLAG $REGION_FLAG \
                    --query 'builds[0].logs.deepLink' --output text 2>/dev/null || echo "N/A")
                err "     Logs: ${LOG_URL}"
                exit 1
                ;;
            *)
                echo -ne "  ⏳ ${PROJ}: ${BID_PHASE} (${ELAPSED}s)\r"
                ;;
        esac
    done
done

echo ""
info "✅ All ${TOTAL} build(s) completed successfully! (${ELAPSED}s total, ${SKIPPED} skipped)"
