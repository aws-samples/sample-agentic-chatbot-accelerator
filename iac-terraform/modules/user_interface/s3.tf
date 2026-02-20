/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - S3 Buckets

Creates:
- Website logs bucket (server access logs for website bucket)
- Website bucket (hosts React app static files)
- Distribution logs bucket (CloudFront access logs)
*/

# -----------------------------------------------------------------------------
# Website Logs Bucket
# Server access logs for the website bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "website_logs" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for logs
  # checkov:skip=CKV_AWS_145:KMS encryption not needed for access logs
  # checkov:skip=CKV2_AWS_62:Event notifications not needed
  # checkov:skip=CKV_AWS_18:This IS the access logs bucket
  bucket = "${local.name_prefix}-website-log-bucket-${data.aws_caller_identity.current.account_id}"

  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-website-log-bucket"
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "website_logs" {
  bucket = aws_s3_bucket.website_logs.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_public_access_block" "website_logs" {
  bucket = aws_s3_bucket.website_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "website_logs" {
  bucket = aws_s3_bucket.website_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "website_logs" {
  bucket = aws_s3_bucket.website_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# -----------------------------------------------------------------------------
# Website Bucket
# Hosts the React app static files
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "website" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for static website
  # checkov:skip=CKV_AWS_145:KMS encryption not needed for public static content
  # checkov:skip=CKV2_AWS_62:Event notifications not needed
  bucket = "${local.name_prefix}-website-bucket-${data.aws_caller_identity.current.account_id}"

  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-website-bucket"
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  rule {
    id     = "cleanup-incomplete-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket = aws_s3_bucket.website.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "website" {
  bucket = aws_s3_bucket.website.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_logging" "website" {
  bucket = aws_s3_bucket.website.id

  target_bucket = aws_s3_bucket.website_logs.id
  target_prefix = "website-logs/"
}

# -----------------------------------------------------------------------------
# Distribution Logs Bucket
# CloudFront access logs
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "distribution_logs" {
  # checkov:skip=CKV_AWS_144:Cross-region replication not needed for logs
  # checkov:skip=CKV_AWS_145:KMS encryption not needed for CloudFront logs
  # checkov:skip=CKV2_AWS_62:Event notifications not needed
  # checkov:skip=CKV_AWS_18:This IS the access logs bucket for CloudFront
  # checkov:skip=CKV2_AWS_6:Public access block partially disabled for CloudFront logging
  bucket = "${local.name_prefix}-distribution-log-bucket-${data.aws_caller_identity.current.account_id}"

  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-distribution-log-bucket"
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "distribution_logs" {
  bucket = aws_s3_bucket.distribution_logs.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_public_access_block" "distribution_logs" {
  # checkov:skip=CKV_AWS_53:ACLs needed for CloudFront logging
  # checkov:skip=CKV_AWS_54:ACLs needed for CloudFront logging
  # checkov:skip=CKV_AWS_55:ACLs needed for CloudFront logging
  # checkov:skip=CKV_AWS_56:ACLs needed for CloudFront logging
  bucket = aws_s3_bucket.distribution_logs.id

  # CloudFront logging requires ACL access - only allow ACLs, still block public access
  block_public_acls       = false
  block_public_policy     = true
  ignore_public_acls      = false
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "distribution_logs" {
  bucket = aws_s3_bucket.distribution_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "distribution_logs" {
  bucket = aws_s3_bucket.distribution_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CloudFront needs OBJECT_WRITER ownership for logging
resource "aws_s3_bucket_ownership_controls" "distribution_logs" {
  # checkov:skip=CKV2_AWS_65:ACLs required for CloudFront logging
  bucket = aws_s3_bucket.distribution_logs.id

  rule {
    object_ownership = "ObjectWriter"
  }
}

# ACL required for CloudFront logging
resource "aws_s3_bucket_acl" "distribution_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.distribution_logs]

  bucket = aws_s3_bucket.distribution_logs.id
  acl    = "log-delivery-write"
}
