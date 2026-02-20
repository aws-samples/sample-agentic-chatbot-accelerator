# Troubleshooting Guide

This guide covers common issues encountered during development and deployment of the Agentic Chatbot Accelerator.

## Docker Build Issues

### Error: "exec format error" during CDK deployment

**Symptom:**
```
#8 [4/7] RUN pip install --no-cache-dir -r requirements.txt
#8 0.131 exec /bin/sh: exec format error
#8 ERROR: process "/bin/sh -c pip install --no-cache-dir -r requirements.txt" did not complete successfully: exit code: 255
```

**Cause:**
CPU architecture mismatch when building ARM64 Docker images on x86_64 (Intel/AMD) machines, or vice versa. This typically occurs when:

- Building for AWS Graviton (ARM64) from an Intel/AMD machine
- The Docker image platform doesn't match the host system architecture

**Solution:**

1. **Set up QEMU for cross-platform builds** (required for cross-architecture builds):
   ```bash
   docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
   ```

   This command registers QEMU binary format handlers with the kernel, enabling execution of ARM64 binaries on x86_64 systems (and vice versa).

2. **Ensure CDK specifies the platform** in `DockerImageAsset`:
   ```typescript
   import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";

   const imageAsset = new DockerImageAsset(this, "MyImage", {
       directory: path.join(__dirname, "docker"),
       platform: Platform.LINUX_ARM64,
   });
   ```

3. **Do NOT hardcode platform in Dockerfile** (let CDK handle it):
   ```dockerfile
   # ❌ Don't do this - causes conflicts with CDK platform setting:
   FROM --platform=linux/arm64 python:3.13-slim

   # ✅ Do this instead - let CDK/buildx specify the platform:
   FROM python:3.13-slim
   ```

**Makefile Integration:**

The QEMU setup can be integrated into your deployment workflow:

```makefile
deploy:
	npm run copy-graphql-util
	npm run gen
	docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
	npx cdk deploy $(if $(PROFILE),--profile $(PROFILE))
```

---

### Docker Buildx not available or not working

**Symptom:**
```
ERROR: docker buildx build requires exactly 1 argument
```
or
```
error: could not create a builder instance with TLS data loaded from environment
```

**Solution:**

1. Create and configure a buildx builder:
   ```bash
   docker buildx create --name multiarch --use
   docker buildx inspect multiarch --bootstrap
   ```

2. Verify the builder is ready:
   ```bash
   docker buildx ls
   ```
   You should see your builder listed with the platforms it supports.

---

### QEMU registration not persisting after reboot

**Symptom:**
Build works once, but fails with "exec format error" after system reboot.

**Cause:**
QEMU binary format registrations don't persist across reboots by default.

**Solution:**
Either:
- Run the QEMU setup command again after each reboot:
  ```bash
  docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
  ```
- Add the command to your Makefile's deploy target (recommended)
- For persistent registration, use the `--persistent yes` flag:
  ```bash
  docker run --rm --privileged multiarch/qemu-user-static --reset -p yes --credential yes
  ```

---

## Deployment Issues

### Error: Transaction Search already enabled in account

**Symptom:**
Deployment fails with the following CloudFormation error:
```
CREATE_FAILED        | AWS::XRay::TransactionSearchConfig | ObservabilityXRay...archConfig
Resource handler returned message: "null" (RequestToken: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, HandlerErrorCode: AlreadyExists)
```

**Cause:**
Transaction search has already been enabled in the AWS account where you're deploying the stack. AWS does not allow enabling transaction search if it's already active at the account level.

**Solution:**
Set `enableTransactionSearch` to `false` in your configuration file:

```yaml
agentCoreObservability:
    enableTransactionSearch: false
    indexingPercentage: 10
```
