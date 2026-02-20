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
