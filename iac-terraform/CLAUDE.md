# iac-terraform — the mirror tree

**Experimental.** `iac-cdk/` is primary and is the source of truth; this tree mirrors it. Run `/mirror-cdk-to-terraform` after every CDK commit that touches infrastructure — the two are meant to ship together with the same feature set and the same defaults.

Structure mirrors the other trees: `modules/<feature>/` corresponds to `iac-cdk/lib/<feature>/` and `src/<feature>/`.

Targets are `tf-`-prefixed from the repo root: `tf-init`, `tf-plan`, `tf-deploy`, `tf-destroy`, `tf-lint` (`tf-fmt` + `tf-validate` + `tf-checkov`). `tf-build-layers` and `tf-build-image` are legacy local-Docker fallbacks, not part of the normal path.

## Terraform has no equivalent of CDK's encapsulation

This is the difference that bites when mirroring. A CDK construct owns its side effects, so deleting the construct deletes them. In Terraform, a resource that needs a value from another module often has to live at **root** level — so the same feature gate has to be applied in several places, and it is easy to mirror the module and miss the root resources.

`main.tf` has two of these today, both browser-upload concerns that logically belong to the UI but sit at root because they need the CloudFront domain and the authenticated role: `aws_s3_bucket_cors_configuration.data_bucket_cors` and `aws_iam_role_policy.cognito_data_bucket_access`. When you gate a module, grep root for anything referencing `module.<name>`.

## Making a module optional re-addresses everything inside it

Adding `count` to a module call changes every address inside it — `module.x.aws_s3_bucket.y` becomes `module.x[0].aws_s3_bucket.y`. Terraform reads that as destroy-and-create, so on a live deployment an innocent-looking "make this optional" plan proposes deleting real buckets and distributions.

The fix is a `moved` block, and it can address the module call wholesale rather than each resource:

```hcl
moved {
  from = module.user_interface
  to   = module.user_interface[0]
}
```

That moves everything nested inside, recursively. Terraform `>= 1.5.0` is already required (`versions.tf`), so this is available. Prefer it to documenting a manual `terraform state mv` — an upgrade that needs hand state surgery is an upgrade most people will get wrong.

Root outputs reading a now-counted module need `one(module.x[*].attr)` so they resolve to `null` instead of failing the apply when the module is absent.

**Always read a plan against pre-change state** before claiming a gate is backward-compatible. "No destroy/create for existing resources" is the assertion that matters, and it is not visible from the diff.
