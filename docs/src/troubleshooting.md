# Troubleshooting Guide

This guide covers common issues encountered during development and deployment of the Agentic Chatbot Accelerator.

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
