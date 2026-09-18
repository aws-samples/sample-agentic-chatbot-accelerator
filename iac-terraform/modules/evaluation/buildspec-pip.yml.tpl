## Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
## SPDX-License-Identifier: MIT-0
##
## Buildspec for CodeBuild: pip-install Lambda dependencies and produce a zip artifact.
## Templated by Terraform — pip_packages and output_zip_name are injected.

version: 0.2

phases:
  install:
    commands:
      - 'echo "Using Python $(python3 --version)"'
      - 'python3 -m pip install --upgrade pip'

  build:
    commands:
      - 'echo "Installing dependencies..."'
      - 'mkdir -p /tmp/package'
      - 'python3 -m pip install ${pip_packages} -t /tmp/package --quiet --upgrade'
      - 'echo "Copying source files..."'
      # `cp -a .` and not `cp *.py`: the judge imports `shared.base_factory` from
      # the generated `shared/` package (see `make copy-model-routing`), and a
      # top-level glob would silently leave that directory out of the bundle —
      # every evaluation would then die at `import evaluator`. Matches the CDK
      # bundler, which also copies the whole context. The strip steps below
      # remove the test dirs and bytecode this pulls in.
      - 'cp -a . /tmp/package/'
      - 'echo "Stripping unnecessary files to reduce package size..."'
      - 'find /tmp/package -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true'
      - 'find /tmp/package -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true'
      - 'find /tmp/package -type d -name "test" -exec rm -rf {} + 2>/dev/null || true'
      - 'find /tmp/package -type f -name "*.pyc" -delete 2>/dev/null || true'
      - 'echo "Creating zip artifact..."'
      - 'cd /tmp/package && zip -r /tmp/output.zip . -q'
      - 'mkdir -p /tmp/artifacts'
      - 'cp /tmp/output.zip /tmp/artifacts/${output_zip_name}'

artifacts:
  files:
    - '${output_zip_name}'
  base-directory: '/tmp/artifacts'
  discard-paths: yes
