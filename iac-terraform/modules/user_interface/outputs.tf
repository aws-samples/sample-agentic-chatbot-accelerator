/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------
User Interface Module - Outputs
*/

# -----------------------------------------------------------------------------
# CloudFront Distribution
# -----------------------------------------------------------------------------

output "distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.website.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.website.arn
}

output "distribution_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.website.domain_name
}

output "website_url" {
  description = "Full HTTPS URL of the website"
  value       = "https://${aws_cloudfront_distribution.website.domain_name}"
}

# -----------------------------------------------------------------------------
# S3 Buckets
# -----------------------------------------------------------------------------

output "website_bucket_name" {
  description = "Name of the website S3 bucket"
  value       = aws_s3_bucket.website.id
}

output "website_bucket_arn" {
  description = "ARN of the website S3 bucket"
  value       = aws_s3_bucket.website.arn
}

output "website_logs_bucket_name" {
  description = "Name of the website logs S3 bucket"
  value       = aws_s3_bucket.website_logs.id
}

output "distribution_logs_bucket_name" {
  description = "Name of the CloudFront distribution logs S3 bucket"
  value       = aws_s3_bucket.distribution_logs.id
}
