# ---------------------------------------------------------------------------- #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ---------------------------------------------------------------------------- #
from typing import Generator

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials


class SigV4HTTPXAuth(httpx.Auth):
    """Sign httpx requests with AWS SigV4 for Amazon Bedrock AgentCore.

    Used to authenticate A2A-protocol calls between agents hosted on
    AgentCore Runtime (orchestrator -> sub-agent). Adapted from the canonical
    AWS sample (strands-agents/samples — 01-a2a-orchestration).

    A fresh signer is created per request so IAM-role credential refresh is
    honored in long-running containers.
    """

    def __init__(self, credentials: Credentials, service: str, region: str):
        self.credentials = credentials
        self.service = service
        self.region = region

    def auth_flow(
        self, request: httpx.Request
    ) -> Generator[httpx.Request, httpx.Response, None]:
        """Sign one outbound httpx request with AWS SigV4.

        The "connection" header is excluded from the server-side signature
        calculation; including it client-side causes SignatureDoesNotMatch,
        so we drop it before building the canonical request.
        """
        headers = dict(request.headers)
        headers.pop("connection", None)

        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=headers,
        )

        frozen_credentials = self.credentials.get_frozen_credentials()
        signer = SigV4Auth(frozen_credentials, self.service, self.region)
        signer.add_auth(aws_request)

        request.headers.update(dict(aws_request.headers))

        yield request
