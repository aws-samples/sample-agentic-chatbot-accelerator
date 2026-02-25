init-python-env:
	uv venv
install-python-packages:
	uv sync
precommit-run:
	pre-commit run --all-files
deploy:
	npm run copy-graphql-util
	npm run gen
# 	docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
	npx cdk deploy $(if $(PROFILE),--profile $(PROFILE))
deploy-finch:
	npm run copy-graphql-util
	npm run gen
	CDK_DOCKER=finch npx cdk deploy $(if $(PROFILE),--profile $(PROFILE))
run-ash:
	pre-commit run --hook-stage manual ash
clean-build:
	git clean -fx lib/
	git clean -fx bin/

# =============================================================================
# Terraform Deployment
# =============================================================================

# Build Lambda layers (auto-detects architecture from terraform.tfvars)
.PHONY: tf-build-layers
tf-build-layers:
	./iac-terraform/scripts/build-layers.sh

# Build and push AgentCore Docker image to ECR
# Note: Skips gracefully if ECR repository doesn't exist yet
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

# Preview changes (builds layers first for accurate plan)
# Reads aws_profile from terraform/terraform.tfvars
tf-plan: tf-build-layers
	cd iac-terraform && terraform init -upgrade && terraform plan

# Deploy everything with proper sequencing:
# 1. Build Lambda layers
# 2. Create ECR repository (so Docker image can be pushed)
# 3. Build and push Docker image
# 4. Apply all infrastructure (now image exists for AgentCore runtime)
# All settings read from iac-terraform/terraform.tfvars
tf-deploy: tf-build-layers
	@echo "Phase 1: Initializing Terraform..."
	cd iac-terraform && terraform init -upgrade
	@echo "Phase 2: Creating ECR repositories (if needed)..."
	cd iac-terraform && terraform apply \
		-target=module.agent_core.aws_kms_key.agent_core \
		-target=module.agent_core.aws_kms_alias.agent_core \
		-target=module.agent_core.aws_ecr_repository.agent_core \
		-target=module.agent_core.aws_ecr_lifecycle_policy.agent_core \
		-target=module.agent_core.aws_ecr_repository.swarm_agent_core \
		-target=module.agent_core.aws_ecr_lifecycle_policy.swarm_agent_core \
		-auto-approve
	@echo "Phase 3: Building and pushing Docker images..."
	./iac-terraform/scripts/build-image.sh
	@echo "Phase 4: Deploying all infrastructure..."
	cd iac-terraform && terraform apply

# Deploy with auto-approve (for CI/CD)
tf-deploy-auto: tf-build-layers
	cd iac-terraform && terraform init -upgrade
	cd iac-terraform && terraform apply \
		-target=module.agent_core.aws_kms_key.agent_core \
		-target=module.agent_core.aws_kms_alias.agent_core \
		-target=module.agent_core.aws_ecr_repository.agent_core \
		-target=module.agent_core.aws_ecr_lifecycle_policy.agent_core \
		-target=module.agent_core.aws_ecr_repository.swarm_agent_core \
		-target=module.agent_core.aws_ecr_lifecycle_policy.swarm_agent_core \
		-auto-approve
	./iac-terraform/scripts/build-image.sh
	cd iac-terraform && terraform apply -auto-approve

# Destroy infrastructure
tf-destroy:
	cd iac-terraform && terraform destroy

# Run Checkov security scan
tf-checkov:
	pre-commit run checkov --hook-stage manual --all-files

# Clean Terraform build artifacts
tf-clean:
	rm -rf iac-terraform/build terraform/.terraform

# Full validation (format + validate + checkov)
tf-lint: tf-fmt tf-validate tf-checkov
