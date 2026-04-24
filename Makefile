# =============================================================================
# Shared build steps (used by both CDK and Terraform)
# =============================================================================

# Copy GraphQL utility file between Lambda functions
copy-graphql-util:
	cp src/api/functions/outgoing-message-handler/graphql.ts src/api/functions/notify-runtime-update/graphql.ts

# Generate TypeScript types from GraphQL schema (requires @aws-amplify/cli)
gen-graphql:
	cd iac-cdk && npx @aws-amplify/cli codegen

# =============================================================================
# Python environment
# =============================================================================

init-python-env:
	uv venv
install-python-packages:
	uv sync
precommit-run:
	pre-commit run --all-files
run-ash:
	pre-commit run --hook-stage manual ash

# =============================================================================
# CDK Deployment
# =============================================================================

# Three-phase deploy:
#   1. Deploy BuilderStack (CodeBuild projects, ECR repos, S3 artifact buckets)
#   2. Run build.sh (triggers all CodeBuild builds in parallel, waits for completion)
#   3. Deploy AcaStack (application — consumes pre-built artifacts)
#
# On first deploy, Phase 2 creates the artifacts that Phase 3 needs.
# On subsequent deploys, Phase 2 rebuilds only what changed (fast).

deploy: copy-graphql-util gen-graphql
	@echo "═══════════════════════════════════════════════════════════"
	@echo "Phase 1: Deploying BuilderStack (CodeBuild infrastructure)"
	@echo "═══════════════════════════════════════════════════════════"
	cd iac-cdk && npx cdk deploy '*-builder' --require-approval never $(if $(PROFILE),--profile $(PROFILE))
	@echo ""
	@echo "═══════════════════════════════════════════════════════════"
	@echo "Phase 2: Running CodeBuild builds"
	@echo "═══════════════════════════════════════════════════════════"
	./iac-cdk/scripts/build.sh $(if $(PROFILE),--profile $(PROFILE)) \
		$(if $(REGION),--region $(REGION))
	@echo ""
	@echo "═══════════════════════════════════════════════════════════"
	@echo "Phase 3: Deploying AcaStack (application)"
	@echo "═══════════════════════════════════════════════════════════"
	cd iac-cdk && npx cdk deploy --all --require-approval never $(if $(PROFILE),--profile $(PROFILE))

# Destroy both stacks (reverse order: AcaStack first, then BuilderStack)
destroy:
	@echo "═══════════════════════════════════════════════════════════"
	@echo "Destroying AcaStack (application)"
	@echo "═══════════════════════════════════════════════════════════"
	cd iac-cdk && npx cdk destroy --all --force $(if $(PROFILE),--profile $(PROFILE))
	cd ..

clean-build:
	git clean -fx iac-cdk/lib/
	git clean -fx iac-cdk/bin/

# =============================================================================
# Terraform Deployment
# =============================================================================

# Legacy: Build Lambda layers locally (requires Docker)
# For debugging or fallback use. Normal deploys use CodeBuild via `tf-deploy`.
.PHONY: tf-build-layers
tf-build-layers:
	./iac-terraform/scripts/build-layers.sh

# Legacy: Build and push AgentCore Docker image to ECR (requires Docker)
# Kept for manual/fallback use. Normal deploys use CodeBuild via `tf-deploy`.
.PHONY: tf-build-image
tf-build-image:
	./iac-terraform/scripts/build-image.sh

# Initialize Terraform
tf-init:
	cd iac-terraform && terraform init

# Validate Terraform configuration
tf-validate:
	cd iac-terraform && terraform validate

# Format Terraform files
tf-fmt:
	cd iac-terraform && terraform fmt -recursive

# Preview changes
# Note: First run may show CodeBuild triggers as changes since builds haven't run yet.
# All builds (Docker images, Python layers, TypeScript Lambdas) are done by CodeBuild.
# Reads aws_profile from terraform/terraform.tfvars
tf-plan:
	cd iac-terraform && terraform init -upgrade && terraform plan

# Deploy everything — single terraform apply.
# ALL builds are done by CodeBuild (triggered automatically when source changes):
# - Docker images (agent-core, swarm-agent-core)
# - Python Lambda layers (boto3)
# - TypeScript Lambdas (notify-runtime-update)
# - React web app (user interface)
# No local Docker or Node.js required for builds!
# All settings read from iac-terraform/terraform.tfvars
tf-deploy: copy-graphql-util gen-graphql
	@echo "Initializing Terraform..."
	cd iac-terraform && terraform init -upgrade
	@echo "Deploying all infrastructure..."
	@echo "CodeBuild will build Docker images, Python layers, TypeScript Lambdas, and React app if source changed."
	cd iac-terraform && terraform apply

# Deploy with auto-approve (for CI/CD)
tf-deploy-auto: copy-graphql-util gen-graphql
	cd iac-terraform && terraform init -upgrade
	cd iac-terraform && terraform apply -auto-approve

# Destroy infrastructure
tf-destroy:
	cd iac-terraform && terraform destroy

# Run Checkov security scan
tf-checkov:
	pre-commit run checkov --hook-stage manual --all-files

# Clean Terraform build artifacts
tf-clean:
	rm -rf iac-terraform/build iac-terraform/.terraform

# Full validation (format + validate + checkov)
tf-lint: tf-fmt tf-validate tf-checkov
