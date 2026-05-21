# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""CRUD routes for Agent Skills (markdown instruction packages).

Skills are stored as markdown files in S3 under the ``skills/`` prefix
of the dedicated skills bucket. Each file uses YAML frontmatter for metadata::

    ---
    name: analog-alarms
    description: Mapping rules for alarm limits and enables...
    ---

    # Analog Alarm Mapping
    ...

The ``name`` in the frontmatter is the canonical identifier.
The S3 key is ``skills/{name}.md``.
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


def _s3_key(name: str) -> str:
    """Build the S3 key for a skill name."""
    return f"{SKILLS_PREFIX}{name}.md"


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


# ---- Queries ---- #


@router.resolver(field_name="listSkills")
@tracer.capture_method
@fetch_user_id(router)
def list_skills(user_id: str) -> Sequence[Mapping]:
    """List all skills from S3 by scanning the skills/ prefix.

    Reads the frontmatter of each .md file to extract name and description.
    """
    logger.info(f"User {user_id} listing skills")

    if not SKILLS_BUCKET_NAME:
        logger.warning("Skills bucket not configured — cannot list skills")
        return []

    try:
        skills: list[dict] = []
        paginator = s3_client.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=SKILLS_BUCKET_NAME, Prefix=SKILLS_PREFIX)

        for page in pages:
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith(".md"):
                    continue

                # Derive name from key: skills/analog-alarms.md → analog-alarms
                name = key[len(SKILLS_PREFIX) :].removesuffix(".md")
                last_modified = obj.get("LastModified", "")
                if hasattr(last_modified, "isoformat"):
                    last_modified = last_modified.isoformat()

                # Read the file to extract frontmatter metadata
                try:
                    resp = s3_client.get_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
                    content = resp["Body"].read().decode("utf-8")
                    meta, _ = _parse_frontmatter(content)
                    description = meta.get("description", "")
                    display_name = meta.get("name") or name
                except Exception as e:
                    logger.warning(f"Failed to read skill '{key}': {e}")
                    description = ""
                    display_name = name

                skills.append(
                    _skill_to_graphql(
                        name=display_name,
                        description=description,
                        s3_key=key,
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
    """Get the full markdown content of a skill by name."""
    logger.info(f"User {user_id} getting skill content: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    key = _s3_key(name)
    try:
        resp = s3_client.get_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        return resp["Body"].read().decode("utf-8")
    except s3_client.exceptions.NoSuchKey:
        return None
    except ClientError as e:
        logger.error(f"S3 error getting skill '{name}': {e}")
        raise RuntimeError(
            f"Failed to retrieve skill '{name}'. Please try again later."
        )


# ---- Mutations ---- #


@router.resolver(field_name="createSkill")
@tracer.capture_method
@fetch_user_id(router)
def create_skill(
    user_id: str,
    name: str,
    description: str,
    content: str,
) -> Mapping:
    """Create a new skill by uploading a markdown file to S3.

    Args:
        name: Skill identifier (used as the filename, e.g. 'analog-alarms')
        description: Short description for the skill metadata
        content: The markdown instructions (body only, without frontmatter)
    """
    logger.info(f"User {user_id} creating skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    if not name or not name.strip():
        raise ValueError("Skill name is required")

    # Validate name is a safe filename
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", name):
        raise ValueError(
            "Skill name must start with a letter/digit and contain only "
            "letters, digits, hyphens, and underscores (max 64 chars)"
        )

    key = _s3_key(name)

    # Check if skill already exists
    try:
        s3_client.head_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        raise ValueError(f"Skill '{name}' already exists")
    except ClientError as e:
        if e.response["Error"]["Code"] != "404":
            raise

    # Build full markdown with frontmatter
    markdown = _build_skill_markdown(name, description, content)

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
    """Update an existing skill's content and/or description.

    If only description is provided, the body is preserved.
    If only content is provided, the existing description is preserved.
    """
    logger.info(f"User {user_id} updating skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    key = _s3_key(name)

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
    """Delete a skill from S3."""
    logger.info(f"User {user_id} deleting skill: {name}")

    if not SKILLS_BUCKET_NAME:
        raise ValueError("Skills bucket not configured")

    key = _s3_key(name)

    # Verify it exists
    try:
        s3_client.head_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            raise ValueError(f"Skill '{name}' not found")
        raise

    try:
        s3_client.delete_object(Bucket=SKILLS_BUCKET_NAME, Key=key)
        logger.info(f"Deleted skill: {name}")
        return True
    except ClientError as e:
        logger.error(f"S3 error deleting skill '{name}': {e}")
        raise RuntimeError(f"Failed to delete skill '{name}'. Please try again later.")
