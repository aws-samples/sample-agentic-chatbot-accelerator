# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""CRUD routes for Agent Skills (markdown instruction packages).

Skills are stored in S3 following the Agent Skills specification directory
structure under the ``skills/`` prefix of the dedicated skills bucket::

    skills/{name}/
    ├── SKILL.md           # Required: YAML frontmatter + markdown instructions
    ├── scripts/           # Optional: executable scripts
    ├── references/        # Optional: reference documents
    └── assets/            # Optional: static files

The ``name`` in the frontmatter is the canonical identifier.
The S3 key for the main file is ``skills/{name}/SKILL.md``.
"""
import os
import re
from datetime import datetime, timezone
from typing import Mapping, Optional, Sequence

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler.graphql_appsync.router import Router
from botocore.exceptions import ClientError
from genai_core.api_helper.auth import fetch_user_id

# ------------------------- Lambda Powertools ------------------------ #
tracer = Tracer()
router = Router()
logger = Logger(service="graphQL-skillsRoute")
# -------------------------------------------------------------------- #

# ----------------------- Environment Variables ---------------------- #
SKILLS_BUCKET_NAME = os.environ.get("SKILLS_BUCKET_NAME", "")
# -------------------------------------------------------------------- #

SKILLS_PREFIX = "skills/"
MAX_RESOURCE_FILES = 20  # Agent Skills SDK default

# ----------------------- Allowed resource directories --------------- #
ALLOWED_RESOURCE_DIRS = ("scripts/", "references/", "assets/")

# ----------------------- Frontmatter Parsing ----------------------- #
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)", re.DOTALL)

s3_client = boto3.client("s3")


def _parse_frontmatter(content: str) -> tuple[dict[str, str], str]:
    """Parse YAML frontmatter from a skill markdown file."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content

    frontmatter, body = match.group(1), match.group(2)
    meta: dict[str, str] = {}
    for line in frontmatter.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta, body.strip()


def _build_skill_markdown(name: str, description: str, content: str) -> str:
    """Build a complete SKILL.md file with frontmatter."""
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{content}\n"


def _skill_md_key(name: str) -> str:
    """Build the S3 key for a skill's SKILL.md file (directory layout)."""
    return f"{SKILLS_PREFIX}{name}/SKILL.md"


def _skill_prefix(name: str) -> str:
    """Build the S3 prefix for a skill directory."""
    return f"{SKILLS_PREFIX}{name}/"


def _skill_to_graphql(
    name: str, description: str, s3_key: str, last_modified: str = ""
) -> dict:
    """Map skill metadata to the GraphQL Skill type."""
    return {
        "name": name,
        "description": description,
        "s3Key": s3_key,
        "lastModified": last_modified,
    }


def _validate_skill_name(name: str) -> None:
    """Validate that a skill name is safe for use as a directory name."""
    if not name or not name.strip():
        raise ValueError("Skill name is required")
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", name):
        raise ValueError(
            "Skill name must start with a letter/digit and contain only "
            "letters, digits, hyphens, and underscores (max 64 chars)"
        )


def _validate_resource_path(path: str) -> None:
    """Validate that a resource path is safe (no traversal, correct prefix)."""
    if not path:
        raise ValueError("Resource path is required")
    if ".." in path or path.startswith("/"):
        raise ValueError(
            "Invalid resource path: must be relative with no '..' components"
        )
    if not path.startswith(ALLOWED_RESOURCE_DIRS):
        raise ValueError(
            f"Resource path must start with one of: {', '.join(ALLOWED_RESOURCE_DIRS)}"
        )
    # Validate filename characters
    filename = path.split("/")[-1]
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$", filename):
        raise ValueError(
            "Resource filename must start with a letter/digit and contain only "
            "letters, digits, dots, hyphens, and underscores"
        )


def _skill_exists(name: str) -> bool:
    """Check if a skill directory exists by looking for its SKILL.md."""
    try:
        s3_client.head_object(Bucket=SKILLS_BUCKET_NAME, Key=_skill_md_key(name))
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return False
        raise


# ============================================================================ #
# Queries
# ============================================================================ #


@router.resolver(field_name="listSkills")
@tracer.capture_method
@fetch_user_id(router)
def list_skills(user_id: str) -> Sequence[Mapping]:
    """List all skills by scanning for skill directories (skills/*/SKILL.md)."""
    logger.info(f"User {user_id} listing skills")

    if not SKILLS_BUCKET_NAME:
        logger.warning("Skills bucket not configured — cannot list skills")
        return []

    try:
        skills: list[dict] = []
        # Use Delimiter to get top-level "directories" under skills/
        paginator = s3_client.get_paginator("list_objects_v2")
        pages = paginator.paginate(
            Bucket=SKILLS_BUCKET_NAME, Prefix=SKILLS_PREFIX, Delimiter="/"
        )

        for page in pages:
            for prefix_info in page.get("CommonPrefixes", []):
                dir_prefix = prefix_info["Prefix"]
                # Extract name: skills/analog-alarms/ → analog-alarms
                name = dir_prefix[len(SKILLS_PREFIX) :].rstrip("/")
                if not name:
                    continue

                # Read SKILL.md from within the directory
                skill_key = f"{dir_prefix}SKILL.md"
                try:
                    resp = s3_client.get_object(
                        Bucket=SKILLS_BUCKET_NAME, Key=skill_key
                    )
                    content = resp["Body"].read().decode("utf-8")
                    last_modified = resp.get("LastModified", "")
                    if hasattr(last_modified, "isoformat"):
                        last_modified = last_modified.isoformat()

                    meta, _ = _parse_frontmatter(content)
                    description = meta.get("description", "")
                    display_name = meta.get("name") or name
                except ClientError:
                    # Directory exists but no SKILL.md — skip
                    logger.warning(
                        f"Skill directory '{name}' missing SKILL.md — skipping"
                    )
                    continue
                except Exception as e:
                    logger.warning(f"Failed to read skill '{skill_key}': {e}")
                    description = ""
                    display_name = name
                    last_modified = ""

                skills.append(
                    _skill_to_graphql(
                        name=display_name,
                        description=description,
                        s3_key=skill_key,
                        last_modified=str(last_modified),
                    )
                )

        logger.info(f"Found {len(skills)} skills")
        return skills

    except ClientError as e:
        logger.error(f"S3 error listing skills: {e}")
        raise RuntimeError("Failed to list skills. Please try again later.")


@router.resolver(field_name="getSkillContent")
@tracer.capture_method
@fetch_user_id(router)
def get_skill_content(user_id: str, name: str) -> Optional[str]:
    """Get the full markdown content (SKILL.md) of a skill by name."""
    logger.info(f"User {user_id} getting skill content: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    key = _skill_md_key(name)
    try:
        resp = s3_client.get_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        return resp["Body"].read().decode("utf-8")
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            return None
        logger.error(f"S3 error getting skill '{name}': {e}")
        raise RuntimeError(
            f"Failed to retrieve skill '{name}'. Please try again later."
        )


@router.resolver(field_name="listSkillResources")
@tracer.capture_method
@fetch_user_id(router)
def list_skill_resources(user_id: str, name: str) -> Sequence[Mapping]:
    """List resource files (scripts/, references/, assets/) for a skill."""
    logger.info(f"User {user_id} listing resources for skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    prefix = _skill_prefix(name)
    resources: list[dict] = []

    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=SKILLS_BUCKET_NAME, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            relative = key[len(prefix) :]
            # Skip SKILL.md itself
            if relative == "SKILL.md" or not relative:
                continue
            # Only include files in known subdirectories
            if relative.startswith(ALLOWED_RESOURCE_DIRS):
                last_modified = obj.get("LastModified", "")
                if hasattr(last_modified, "isoformat"):
                    last_modified = last_modified.isoformat()
                resources.append(
                    {
                        "path": relative,
                        "size": obj["Size"],
                        "lastModified": str(last_modified),
                    }
                )

    return resources


@router.resolver(field_name="getSkillResource")
@tracer.capture_method
@fetch_user_id(router)
def get_skill_resource(user_id: str, name: str, path: str) -> Optional[str]:
    """Get the text content of a resource file within a skill directory."""
    logger.info(f"User {user_id} getting resource '{path}' for skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    _validate_resource_path(path)

    key = f"{SKILLS_PREFIX}{name}/{path}"
    try:
        resp = s3_client.get_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        return resp["Body"].read().decode("utf-8")
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            return None
        raise RuntimeError(f"Failed to retrieve resource '{path}' for skill '{name}'.")


# ============================================================================ #
# Mutations
# ============================================================================ #


@router.resolver(field_name="createSkill")
@tracer.capture_method
@fetch_user_id(router)
def create_skill(
    user_id: str,
    name: str,
    description: str,
    content: str,
) -> Mapping:
    """Create a new skill by uploading SKILL.md to a skill directory in S3.

    Args:
        name: Skill identifier (used as the directory name, e.g. 'analog-alarms')
        description: Short description for the skill metadata
        content: The markdown instructions (body only, without frontmatter)
    """
    logger.info(f"User {user_id} creating skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    _validate_skill_name(name)

    # Check if skill already exists
    if _skill_exists(name):
        raise ValueError(f"Skill '{name}' already exists")

    # Build full markdown with frontmatter
    markdown = _build_skill_markdown(name, description, content)
    key = _skill_md_key(name)

    try:
        s3_client.put_object(
            Bucket=SKILLS_BUCKET_NAME,
            Key=key,
            Body=markdown.encode("utf-8"),
            ContentType="text/markdown; charset=utf-8",
        )
    except ClientError as e:
        logger.error(f"S3 error creating skill '{name}': {e}")
        raise RuntimeError(f"Failed to create skill '{name}'. Please try again later.")

    logger.info(f"Created skill: {name}")
    return _skill_to_graphql(
        name=name,
        description=description,
        s3_key=key,
        last_modified=datetime.now(timezone.utc).isoformat(),
    )


@router.resolver(field_name="updateSkill")
@tracer.capture_method
@fetch_user_id(router)
def update_skill(
    user_id: str,
    name: str,
    description: Optional[str] = None,
    content: Optional[str] = None,
) -> Mapping:
    """Update an existing skill's SKILL.md content and/or description.

    If only description is provided, the body is preserved.
    If only content is provided, the existing description is preserved.
    """
    logger.info(f"User {user_id} updating skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    key = _skill_md_key(name)

    # Read existing content
    try:
        resp = s3_client.get_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        existing = resp["Body"].read().decode("utf-8")
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            raise ValueError(f"Skill '{name}' not found")
        raise

    existing_meta, existing_body = _parse_frontmatter(existing)

    # Merge: use new values if provided, else keep existing
    final_description = (
        description if description is not None else existing_meta.get("description", "")
    )
    final_body = content if content is not None else existing_body

    markdown = _build_skill_markdown(name, final_description, final_body)

    try:
        s3_client.put_object(
            Bucket=SKILLS_BUCKET_NAME,
            Key=key,
            Body=markdown.encode("utf-8"),
            ContentType="text/markdown; charset=utf-8",
        )
    except ClientError as e:
        logger.error(f"S3 error updating skill '{name}': {e}")
        raise RuntimeError(f"Failed to update skill '{name}'. Please try again later.")

    logger.info(f"Updated skill: {name}")
    return _skill_to_graphql(
        name=name,
        description=final_description,
        s3_key=key,
        last_modified=datetime.now(timezone.utc).isoformat(),
    )


@router.resolver(field_name="deleteSkill")
@tracer.capture_method
@fetch_user_id(router)
def delete_skill(user_id: str, name: str) -> bool:
    """Delete a skill and all its resource files from S3."""
    logger.info(f"User {user_id} deleting skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    # Verify it exists
    if not _skill_exists(name):
        raise ValueError(f"Skill '{name}' not found")

    # Delete all objects under the skill prefix (SKILL.md + resources)
    prefix = _skill_prefix(name)
    try:
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=SKILLS_BUCKET_NAME, Prefix=prefix):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if objects:
                s3_client.delete_objects(
                    Bucket=SKILLS_BUCKET_NAME, Delete={"Objects": objects}
                )

        logger.info(f"Deleted skill: {name}")
        return True
    except ClientError as e:
        logger.error(f"S3 error deleting skill '{name}': {e}")
        raise RuntimeError(f"Failed to delete skill '{name}'. Please try again later.")


@router.resolver(field_name="uploadSkillResource")
@tracer.capture_method
@fetch_user_id(router)
def upload_skill_resource(user_id: str, name: str, path: str, content: str) -> Mapping:
    """Upload a resource file to a skill directory.

    Args:
        name: Skill name (directory must already exist with SKILL.md)
        path: Relative path within the skill directory (e.g. 'scripts/extract.py')
        content: Text content of the resource file
    """
    logger.info(f"User {user_id} uploading resource '{path}' for skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    _validate_resource_path(path)

    # Verify skill exists
    if not _skill_exists(name):
        raise ValueError(f"Skill '{name}' not found — create the skill first")

    # Enforce max resource files limit
    prefix = _skill_prefix(name)
    existing_resources = 0
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=SKILLS_BUCKET_NAME, Prefix=prefix):
        for obj in page.get("Contents", []):
            relative = obj["Key"][len(prefix) :]
            if relative != "SKILL.md" and relative.startswith(ALLOWED_RESOURCE_DIRS):
                existing_resources += 1

    # Check if this is an update (file already exists) or a new file
    target_key = f"{SKILLS_PREFIX}{name}/{path}"
    is_update = False
    try:
        s3_client.head_object(Bucket=SKILLS_BUCKET_NAME, Key=target_key)
        is_update = True
    except ClientError:
        pass

    if not is_update and existing_resources >= MAX_RESOURCE_FILES:
        raise ValueError(
            f"Maximum resource files ({MAX_RESOURCE_FILES}) reached for skill '{name}'. "
            f"Delete existing resources before uploading new ones."
        )

    # Enforce file size limit (1MB)
    content_bytes = content.encode("utf-8")
    if len(content_bytes) > 1_048_576:
        raise ValueError("Resource file content exceeds maximum size of 1MB")

    try:
        s3_client.put_object(
            Bucket=SKILLS_BUCKET_NAME,
            Key=target_key,
            Body=content_bytes,
            ContentType="application/octet-stream",
        )
    except ClientError as e:
        logger.error(f"S3 error uploading resource '{path}' for skill '{name}': {e}")
        raise RuntimeError("Failed to upload resource. Please try again later.")

    logger.info(f"Uploaded resource '{path}' for skill: {name}")
    return {
        "path": path,
        "size": len(content_bytes),
        "lastModified": datetime.now(timezone.utc).isoformat(),
    }


@router.resolver(field_name="deleteSkillResource")
@tracer.capture_method
@fetch_user_id(router)
def delete_skill_resource(user_id: str, name: str, path: str) -> bool:
    """Delete a resource file from a skill directory."""
    logger.info(f"User {user_id} deleting resource '{path}' for skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    _validate_resource_path(path)

    key = f"{SKILLS_PREFIX}{name}/{path}"

    # Verify it exists
    try:
        s3_client.head_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            raise ValueError(f"Resource '{path}' not found in skill '{name}'")
        raise

    try:
        s3_client.delete_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        logger.info(f"Deleted resource '{path}' for skill: {name}")
        return True
    except ClientError as e:
        logger.error(f"S3 error deleting resource '{path}' for skill '{name}': {e}")
        raise RuntimeError("Failed to delete resource. Please try again later.")
