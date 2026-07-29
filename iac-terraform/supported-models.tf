/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
*/

# -----------------------------------------------------------------------------
# Region-scoped supported-model catalog
#
# Mirrors iac-cdk/lib/shared/supported-models.ts — keep the two in sync.
# See docs/adr/0004-region-scoped-model-catalog.md for why this is hard-coded
# rather than an operator input.
#
# Ids are LITERAL and ready to use: no [REGION-PREFIX] token, no runtime
# substitution. A display name may map to a different literal id per region
# (a geo-prefixed Converse id in one, an unprefixed Mantle id in another).
# Editing this map + re-applying is how the offered model set changes.
#
# NOTE: the region key list is duplicated in the aws_region validation block in
# variables.tf. Terraform cannot reference a local from a variable validation,
# so the two must be kept in sync by hand.
#
# DELIBERATE OMISSION — `xai.grok-4.3`: on Mantle and otherwise working, but its
# tool-calling is incompatible with the Strands streaming contract (xAI returns
# tool calls as a complete response needing a fresh call with the results;
# Strands pauses and resumes one stream). See strands-agents/harness-sdk#1340.
# The tool runs, the stream never resumes, and the caller sees a read timeout.
# Re-add once that issue lands.
# -----------------------------------------------------------------------------
locals {
  supported_models_by_region = {
    # N. Virginia
    "us-east-1" = {
      # OpenAI
      "GPT-5.6 Luna"  = "openai.gpt-5.6-luna"
      "GPT-5.6 Sol"   = "openai.gpt-5.6-sol"
      "GPT-5.6 Terra" = "openai.gpt-5.6-terra"
      "GPT-5.5"       = "openai.gpt-5.5"
      "GPT-5.4"       = "openai.gpt-5.4"
      "GPT OSS 20B"   = "openai.gpt-oss-20b"
      "GPT OSS 120B"  = "openai.gpt-oss-120b"
      # Anthropic
      "Claude Sonnet 5" = "anthropic.claude-sonnet-5"
      "Claude Opus 4.8" = "anthropic.claude-opus-4-8"
      # Amazon
      "Nova 2 Lite"  = "us.amazon.nova-2-lite-v1:0"
      "Nova 2 Sonic" = "amazon.nova-2-sonic-v1:0"
      # Deepseek
      "DeepSeek V3.2" = "deepseek.v3.2"
      # Google
      "Gemma 4 31B"     = "google.gemma-4-31b"
      "Gemma 4 E2B"     = "google.gemma-4-e2b"
      "Gemma 4 26B-A4B" = "google.gemma-4-26b-a4b"
      "Gemma 3 4B IT"   = "google.gemma-3-4b-it"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Mistral Large 3"   = "mistral.mistral-large-3-675b-instruct"
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Moonshot AI
      "Kimi K2.5" = "moonshotai.kimi-k2.5"
      # nVIDIA
      "NVIDIA Nemotron 3 Super 120B" = "nvidia.nemotron-super-3-120b"
      # Qwen
      "Qwen3 Next 80B A3B"   = "qwen.qwen3-next-80b-a3b-instruct"
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 5"         = "zai.glm-5"
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # Ohio
    "us-east-2" = {
      # OpenAI
      "GPT-5.6 Luna"  = "openai.gpt-5.6-luna"
      "GPT-5.6 Sol"   = "openai.gpt-5.6-sol"
      "GPT-5.6 Terra" = "openai.gpt-5.6-terra"
      "GPT-5.5"       = "openai.gpt-5.5"
      "GPT-5.4"       = "openai.gpt-5.4"
      "GPT OSS 20B"   = "openai.gpt-oss-20b"
      "GPT OSS 120B"  = "openai.gpt-oss-120b"
      # Amazon
      "Nova 2 Lite" = "us.amazon.nova-2-lite-v1:0"
      # Deepseek
      "DeepSeek V3.2" = "deepseek.v3.2"
      # Google
      "Gemma 4 31B"     = "google.gemma-4-31b"
      "Gemma 4 E2B"     = "google.gemma-4-e2b"
      "Gemma 4 26B-A4B" = "google.gemma-4-26b-a4b"
      "Gemma 3 4B IT"   = "google.gemma-3-4b-it"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Mistral Large 3"   = "mistral.mistral-large-3-675b-instruct"
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Moonshot AI
      "Kimi K2.5" = "moonshotai.kimi-k2.5"
      # nVIDIA
      "NVIDIA Nemotron 3 Super 120B" = "nvidia.nemotron-super-3-120b"
      # Qwen
      "Qwen3 Next 80B A3B"   = "qwen.qwen3-next-80b-a3b-instruct"
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 5"         = "zai.glm-5"
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # Oregon
    "us-west-2" = {
      # OpenAI
      "GPT-5.6 Luna"          = "openai.gpt-5.6-luna"
      "GPT-5.6 Terra"         = "openai.gpt-5.6-terra"
      "GPT-5.4"               = "openai.gpt-5.4"
      "GPT OSS Safeguard 20B" = "openai.gpt-oss-safeguard-20b"
      "GPT OSS 20B"           = "openai.gpt-oss-20b"
      "GPT OSS 120B"          = "openai.gpt-oss-120b"
      # Amazon
      "Nova 2 Lite"  = "us.amazon.nova-2-lite-v1:0"
      "Nova 2 Sonic" = "amazon.nova-2-sonic-v1:0"
      # Deepseek
      "DeepSeek V3.2" = "deepseek.v3.2"
      # Google
      "Gemma 4 31B"     = "google.gemma-4-31b"
      "Gemma 4 E2B"     = "google.gemma-4-e2b"
      "Gemma 4 26B-A4B" = "google.gemma-4-26b-a4b"
      "Gemma 3 4B IT"   = "google.gemma-3-4b-it"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Mistral Large 3"   = "mistral.mistral-large-3-675b-instruct"
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Moonshot AI
      "Kimi K2.5" = "moonshotai.kimi-k2.5"
      # nVIDIA
      "NVIDIA Nemotron 3 Super 120B" = "nvidia.nemotron-super-3-120b"
      # Qwen
      "Qwen3 Next 80B A3B"   = "qwen.qwen3-next-80b-a3b-instruct"
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 5"         = "zai.glm-5"
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # Frankfurt
    "eu-central-1" = {
      # OpenAI
      "GPT OSS Safeguard 20B" = "openai.gpt-oss-safeguard-20b"
      "GPT OSS 20B"           = "openai.gpt-oss-20b"
      "GPT OSS 120B"          = "openai.gpt-oss-120b"
      # Amazon
      "Nova 2 Lite" = "eu.amazon.nova-2-lite-v1:0"
      # Google
      "Gemma 4 31B"     = "google.gemma-4-31b"
      "Gemma 4 E2B"     = "google.gemma-4-e2b"
      "Gemma 4 26B-A4B" = "google.gemma-4-26b-a4b"
      "Gemma 3 4B IT"   = "google.gemma-3-4b-it"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Qwen
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # Stockholm
    "eu-north-1" = {
      # OpenAI
      "GPT OSS 20B"  = "openai.gpt-oss-20b"
      "GPT OSS 120B" = "openai.gpt-oss-120b"
      # Anthropic
      "Claude Opus 4.8" = "anthropic.claude-opus-4-8"
      # Amazon
      "Nova 2 Lite"  = "eu.amazon.nova-2-lite-v1:0"
      "Nova 2 Sonic" = "amazon.nova-2-sonic-v1:0"
      # Deepseek
      "DeepSeek V3.2" = "deepseek.v3.2"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Mistral Large 3"   = "mistral.mistral-large-3-675b-instruct"
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Moonshot AI
      "Kimi K2.5" = "moonshotai.kimi-k2.5"
      # Qwen
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 5"         = "zai.glm-5"
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # Ireland
    "eu-west-1" = {
      # OpenAI
      "GPT OSS 20B"  = "openai.gpt-oss-20b"
      "GPT OSS 120B" = "openai.gpt-oss-120b"
      # Anthropic
      "Claude Sonnet 5" = "anthropic.claude-sonnet-5"
      "Claude Opus 4.8" = "anthropic.claude-opus-4-8"
      # Amazon
      "Nova 2 Lite" = "eu.amazon.nova-2-lite-v1:0"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # nVIDIA
      "NVIDIA Nemotron 3 Super 120B" = "nvidia.nemotron-super-3-120b"
      # Qwen
      "Qwen3 Next 80B A3B"   = "qwen.qwen3-next-80b-a3b-instruct"
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
    # London
    "eu-west-2" = {
      # OpenAI
      "GPT OSS 20B"  = "openai.gpt-oss-20b"
      "GPT OSS 120B" = "openai.gpt-oss-120b"
      # Amazon
      "Nova 2 Lite" = "eu.amazon.nova-2-lite-v1:0"
      # Deepseek
      "DeepSeek V3.2" = "deepseek.v3.2"
      # MiniMax
      "MiniMax M2.5" = "minimax.minimax-m2.5"
      # Mistral
      "Mistral Large 3"   = "mistral.mistral-large-3-675b-instruct"
      "Ministral 14B 3.0" = "mistral.ministral-3-14b-instruct"
      "Ministral 3 8B"    = "mistral.ministral-3-8b-instruct"
      "Ministral 3B"      = "mistral.ministral-3-3b-instruct"
      # Moonshot AI
      "Kimi K2.5" = "moonshotai.kimi-k2.5"
      # nVIDIA
      "NVIDIA Nemotron 3 Super 120B" = "nvidia.nemotron-super-3-120b"
      # Qwen
      "Qwen3 Next 80B A3B"   = "qwen.qwen3-next-80b-a3b-instruct"
      "Qwen3 32B"            = "qwen.qwen3-32b"
      "Qwen3 235B A22B 2507" = "qwen.qwen3-235b-a22b-2507"
      # Z.AI
      "GLM 5"         = "zai.glm-5"
      "GLM 4.7 Flash" = "zai.glm-4.7-flash"
    }
  }

  # The deploy region's flat display -> id slice. Equivalent to modelsForRegion()
  # in the CDK module. var.aws_region is a concrete string at plan time, so no
  # token indirection is needed here (unlike CDK, where Aws.REGION is an
  # unresolved token at synth and the region must come from the environment).
  supported_models = local.supported_models_by_region[var.aws_region]
}
