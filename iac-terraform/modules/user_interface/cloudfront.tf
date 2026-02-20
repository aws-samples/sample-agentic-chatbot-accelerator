/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - CloudFront Distribution

Creates:
- Origin Access Control (OAC) for S3
- CloudFront distribution with HTTPS redirect, SPA error handling
- S3 bucket policy allowing CloudFront access
*/

# -----------------------------------------------------------------------------
# Origin Access Control (OAC)
# Allows CloudFront to access private S3 bucket
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "website" {
  name                              = "${local.name_prefix}-website-oac"
  description                       = "OAC for ${local.name_prefix} website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# CloudFront Distribution
# -----------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "website" {
  # checkov:skip=CKV_AWS_68:WAF not required - Cognito auth configured
  # checkov:skip=CKV_AWS_86:Access logging is enabled
  # checkov:skip=CKV_AWS_310:Origin failover not needed for static website
  # checkov:skip=CKV_AWS_374:Geo restriction configurable via enable_geo_restrictions variable
  # checkov:skip=CKV2_AWS_32:Response headers policy optional
  # checkov:skip=CKV2_AWS_42:Default CloudFront certificate acceptable for demo app
  # checkov:skip=CKV2_AWS_47:WAF not required - Cognito auth configured
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  http_version        = "http2and3"
  price_class         = "PriceClass_All"
  comment             = "${local.name_prefix} website distribution"

  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "S3Origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.website.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3Origin"

    # Using AWS managed CachingOptimized policy ID (hardcoded to avoid data source timing issues)
    # See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    viewer_protocol_policy = "redirect-to-https"
    compress               = true
  }

  # SPA error handling - redirect 403/404 to index.html
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  # Access logging
  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.distribution_logs.bucket_regional_domain_name
    prefix          = "cloudfront-logs/"
  }

  # Geo restrictions (optional)
  restrictions {
    geo_restriction {
      restriction_type = var.enable_geo_restrictions ? "whitelist" : "none"
      locations        = var.enable_geo_restrictions ? var.allowed_geo_regions : []
    }
  }

  # TLS configuration
  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-website-distribution"
  })

  depends_on = [aws_s3_bucket.website, aws_s3_bucket.distribution_logs]
}


# -----------------------------------------------------------------------------
# S3 Bucket Policy
# Allow CloudFront to access the website bucket via OAC
# -----------------------------------------------------------------------------

resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.website.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.website.arn
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_distribution.website]
}
