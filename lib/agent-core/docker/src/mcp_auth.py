# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# This module extends the MCP StreamableHTTPTransport to add AWS SigV4 request signing
# for authentication with MCP servers that authenticate using AWS IAM.
# ------------------------------------------------------------------------ #

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Generator

import httpx
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from mcp.client.streamable_http import (
    GetSessionIdCallback,
    StreamableHTTPTransport,
    streamablehttp_client,
)

# Note: _httpx_utils is a private module in the MCP library. This import may
# need updating if the MCP library restructures its internals in future versions.
from mcp.shared._httpx_utils import McpHttpClientFactory, create_mcp_http_client
from mcp.shared.message import SessionMessage


class SigV4HTTPXAuth(httpx.Auth):
    """
    HTTPX Auth class that signs requests with AWS SigV4.

    This auth handler can be used with any HTTPX client to automatically
    sign requests using AWS Signature Version 4.

    Args:
        credentials: AWS credentials for signing requests.
        service: AWS service name (e.g., 'bedrock-agentcore', 'lambda').
        region: AWS region (e.g., 'us-east-1').

    Raises:
        ValueError: If credentials, service, or region are not provided.
    """

    __slots__ = ("credentials", "service", "region", "signer")

    def __init__(
        self,
        credentials: Credentials,
        service: str,
        region: str,
    ) -> None:
        if not credentials:
            raise ValueError("AWS credentials are required for SigV4 signing")
        if not service:
            raise ValueError("AWS service name is required for SigV4 signing")
        if not region:
            raise ValueError("AWS region is required for SigV4 signing")

        self.credentials = credentials
        self.service = service
        self.region = region
        self.signer = SigV4Auth(credentials, service, region)

    def auth_flow(
        self, request: httpx.Request
    ) -> Generator[httpx.Request, httpx.Response, None]:
        """
        Signs the request with SigV4 and adds the signature to the request headers.

        Args:
            request: The HTTPX request to sign.

        Yields:
            The signed request with SigV4 authorization headers.

        Raises:
            RuntimeError: If request signing fails.
        """
        # Create an AWS request
        headers = dict(request.headers)
        # Header 'connection' = 'keep-alive' is not used in calculating the request
        # signature on the server-side, and results in a signature mismatch if included
        headers.pop("connection", None)  # Remove if present, ignore if not

        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=headers,
        )

        # Sign the request with SigV4
        try:
            self.signer.add_auth(aws_request)
        except Exception as e:
            raise RuntimeError(
                f"Failed to sign request with SigV4 for service '{self.service}' "
                f"in region '{self.region}': {e}"
            ) from e

        # Add the signature header to the original request
        request.headers.update(dict(aws_request.headers))

        yield request


class StreamableHTTPTransportWithSigV4(StreamableHTTPTransport):
    """
    Streamable HTTP client transport with AWS SigV4 signing support.

    This transport enables communication with MCP servers that authenticate using AWS IAM,
    such as servers behind a Lambda function URL or API Gateway.

    Note: This class is available for direct transport instantiation when fine-grained
    control is needed. For most use cases, prefer the `streamablehttp_client_with_sigv4`
    async context manager function which provides a simpler interface.
    """

    def __init__(
        self,
        url: str,
        credentials: Credentials,
        service: str,
        region: str,
        headers: dict[str, str] | None = None,
        timeout: float | timedelta = 30,
        sse_read_timeout: float | timedelta = 60 * 5,
    ) -> None:
        """Initialize the StreamableHTTP transport with SigV4 signing.

        Args:
            url: The endpoint URL.
            credentials: AWS credentials for signing.
            service: AWS service name (e.g., 'lambda').
            region: AWS region (e.g., 'us-east-1').
            headers: Optional headers to include in requests.
            timeout: HTTP timeout for regular operations.
            sse_read_timeout: Timeout for SSE read operations.
        """
        # Initialize parent class with SigV4 auth handler
        super().__init__(
            url=url,
            headers=headers,
            timeout=timeout,
            sse_read_timeout=sse_read_timeout,
            auth=SigV4HTTPXAuth(credentials, service, region),
        )

        self.credentials = credentials
        self.service = service
        self.region = region


@asynccontextmanager
async def streamablehttp_client_with_sigv4(
    url: str,
    credentials: Credentials,
    service: str,
    region: str,
    headers: dict[str, str] | None = None,
    timeout: float | timedelta = 30,
    sse_read_timeout: float | timedelta = 60 * 5,
    terminate_on_close: bool = True,
    httpx_client_factory: McpHttpClientFactory = create_mcp_http_client,
) -> AsyncGenerator[
    tuple[
        MemoryObjectReceiveStream[SessionMessage | Exception],
        MemoryObjectSendStream[SessionMessage],
        GetSessionIdCallback,
    ],
    None,
]:
    """
    Client transport for Streamable HTTP with SigV4 auth.

    This transport enables communication with MCP servers that authenticate using AWS IAM,
    such as servers behind a Lambda function URL or API Gateway.

    Yields:
        Tuple containing:
            - read_stream: Stream for reading messages from the server
            - write_stream: Stream for sending messages to the server
            - get_session_id_callback: Function to retrieve the current session ID
    """
    async with streamablehttp_client(
        url=url,
        headers=headers,
        timeout=timeout,
        sse_read_timeout=sse_read_timeout,
        terminate_on_close=terminate_on_close,
        httpx_client_factory=httpx_client_factory,
        auth=SigV4HTTPXAuth(credentials, service, region),
    ) as result:
        yield result
