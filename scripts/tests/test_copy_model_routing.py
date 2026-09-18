# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
"""Contract tests for the `copy-model-routing` make target.

The target materialises the model-routing modules inside the
evaluation-executor pip bundle. Only dry runs (`make -n`) are used for the
deploy targets — the real ones reach AWS.
"""

import filecmp
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "src" / "agent-core" / "shared"
FUNCTION_DIR = REPO_ROOT / "src" / "api" / "functions" / "evaluation-executor"
COPY_DIR = FUNCTION_DIR / "shared"
API_DOC = REPO_ROOT / "src" / "api" / "CLAUDE.md"
# The generated package only — the function's own tracked files are not T1's.
COPY_PREFIX = "src/api/functions/evaluation-executor/shared/"

COPIED_MODULES = (
    "base_factory.py",
    "mantle_support.py",
    "stream_types.py",
    "base_constants.py",
)
EXPECTED_FILES = frozenset(COPIED_MODULES + ("__init__.py",))

# Distributions the pip bundle does not carry: the copy may only need boto3,
# strands-agents and pydantic at import time.
ABSENT_FROM_BUNDLE = ("bedrock_agentcore", "openai", "anthropic")

_BLOCKER = """
import importlib, sys
BLOCK = set({blocked!r})


class Blocker:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in BLOCK:
            raise ImportError("absent from the bundle: " + fullname)
        return None


sys.meta_path.insert(0, Blocker())
for _name in [k for k in sys.modules if k.split(".")[0] in BLOCK]:
    del sys.modules[_name]
"""


def run_make(*targets, cwd=REPO_ROOT):
    return subprocess.run(
        ["make", *targets],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=300,
    )


def run_python(script, cwd):
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=cwd,
        capture_output=True,
        text=True,
        env=env,
        timeout=300,
    )


def copied_files():
    return {p.name for p in COPY_DIR.iterdir() if p.is_file()}


@pytest.fixture(scope="module")
def copy_generated():
    result = run_make("copy-model-routing")
    assert result.returncode == 0, result.stderr
    return COPY_DIR


def test_target_produces_exactly_the_five_files(copy_generated):
    assert copied_files() == set(EXPECTED_FILES)


def test_target_is_idempotent_over_an_existing_copy(copy_generated):
    first = run_make("copy-model-routing")
    second = run_make("copy-model-routing")
    assert (first.returncode, second.returncode) == (0, 0), second.stderr
    assert copied_files() == set(EXPECTED_FILES)


def test_copied_modules_are_verbatim(copy_generated):
    mismatched = [
        name
        for name in COPIED_MODULES
        if not filecmp.cmp(SOURCE_DIR / name, COPY_DIR / name, shallow=False)
    ]
    assert mismatched == []


def test_synthesized_init_is_empty(copy_generated):
    assert (COPY_DIR / "__init__.py").read_bytes() == b""


def test_import_succeeds_without_the_absent_distributions(copy_generated):
    script = _BLOCKER.format(blocked=ABSENT_FROM_BUNDLE) + (
        "m = importlib.import_module('shared.base_factory')\n"
        "print(m.__file__)\n"
        "print(sorted(k for k in sys.modules if k.split('.')[0] in BLOCK))\n"
        "print(m.BaseAgentFactory.create_model.__name__)\n"
    )
    result = run_python(script, cwd=FUNCTION_DIR)
    assert result.returncode == 0, result.stderr
    module_file, still_loaded, symbol = result.stdout.splitlines()[:3]
    assert Path(module_file).parent == COPY_DIR
    assert still_loaded == "[]"
    assert symbol == "create_model"


@pytest.mark.parametrize("name", ABSENT_FROM_BUNDLE)
def test_the_blocked_distributions_are_installed_but_blocked(name):
    unblocked = run_python(f"import {name}", cwd=FUNCTION_DIR)
    blocked = run_python(
        _BLOCKER.format(blocked=(name,)) + f"import {name}", cwd=FUNCTION_DIR
    )
    assert unblocked.returncode == 0, f"{name} not installed: import check is vacuous"
    assert blocked.returncode != 0
    assert "absent from the bundle" in blocked.stderr


def test_import_fails_when_the_copy_is_absent(tmp_path):
    for name in ("index.py", "evaluator.py"):
        shutil.copy(FUNCTION_DIR / name, tmp_path / name)
    result = run_python("import shared.base_factory", cwd=tmp_path)
    assert result.returncode != 0
    assert "ModuleNotFoundError" in result.stderr


@pytest.mark.parametrize(
    "target,apply_marker",
    [
        ("deploy", "cdk deploy"),
        ("tf-deploy", "terraform apply"),
        # Edge-case row "fresh clone bypasses make" cites Makefile:141 too.
        ("tf-deploy-auto", "terraform apply"),
    ],
)
def test_copy_runs_before_the_infrastructure_step(target, apply_marker):
    result = run_make("-n", target)
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    copy_lines = [i for i, line in enumerate(lines) if "src/agent-core/shared/" in line]
    init_lines = [
        i
        for i, line in enumerate(lines)
        if "evaluation-executor/shared/__init__.py" in line
    ]
    apply_lines = [i for i, line in enumerate(lines) if apply_marker in line]
    assert copy_lines, f"copy-model-routing is not a prerequisite of {target}"
    assert apply_lines, f"no {apply_marker!r} step found in {target}"
    assert max(copy_lines + init_lines) < min(apply_lines)


def test_target_recipe_is_unconditional(copy_generated):
    result = run_make("-n", "copy-model-routing")
    assert result.returncode == 0, result.stderr
    recipe = result.stdout.lower()
    assert "config" not in recipe
    assert not re.search(r"\b(if|ifeq|ifdef|test -|\[ -)", recipe)


@pytest.mark.parametrize("name", sorted(EXPECTED_FILES))
def test_generated_files_are_gitignored(copy_generated, name):
    result = subprocess.run(
        ["git", "check-ignore", "-v", str(COPY_DIR / name)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"{name} is not gitignored"


def git_status(*flags):
    result = subprocess.run(
        ["git", "status", "--porcelain", *flags],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return [line for line in result.stdout.splitlines() if COPY_PREFIX in line]


def test_git_status_never_reports_the_generated_copy(copy_generated):
    assert git_status() == []
    assert git_status("--ignored") != []


def test_read_only_copy_fails_the_target_loudly(copy_generated):
    victim = COPY_DIR / "base_factory.py"
    original_mode = stat.S_IMODE(victim.stat().st_mode)
    victim.chmod(0o444)
    try:
        result = run_make("copy-model-routing")
    finally:
        victim.chmod(original_mode)
        run_make("copy-model-routing")
    assert result.returncode != 0
    assert filecmp.cmp(SOURCE_DIR / "base_factory.py", victim, shallow=False)


def test_api_doc_names_the_source_and_the_overwrite():
    text = API_DOC.read_text()
    assert "src/agent-core/shared/" in text
    assert "evaluation-executor/shared/" in text
    assert re.search(r"(overwritten|regenerated)[^.\n]*every[^.\n]*deploy", text)
