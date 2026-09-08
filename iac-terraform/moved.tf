/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# State migrations
#
# Adding `count` to a module call re-addresses everything inside it, which
# Terraform otherwise plans as destroy-and-create — on a live deployment that
# means deleting the CloudFront distribution and the website buckets. Addressing
# the module call moves all 34 resources recursively; the module's three data
# sources are re-read, not moved.
#
# Safe to delete once every deployment has applied once with this block present.
# -----------------------------------------------------------------------------

moved {
  from = module.user_interface
  to   = module.user_interface[0]
}
