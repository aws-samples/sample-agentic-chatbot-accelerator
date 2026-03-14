# ------------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
#
# MCP (Model Context Protocol) client manager for handling MCP server connections.
# ------------------------------------------------------------------------------ #
import os
from logging import Logger
from typing import Any

from mcp.client.streamable_http import streamablehttp_client
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient


class MCPClientManager:
    """
    Manages MCP (Model Context Protocol) client connections.

    This class handles the lifecycle of MCP clients including creation,
    connection management, and tool aggregation from multiple MCP servers.

    Usage:
        manager = MCPClientManager(mcp_servers=["server1"], logger=logger, mcp_registry=AVAILABLE_MCPS)
        with manager:
            tools = manager.load_mcp_tools()
    """

    def __init__(
        self,
        mcp_servers: list[str],
        logger: Logger,
        mcp_registry: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        """Initialize the MCP client manager.

        Args:
            mcp_servers: List of MCP server names to connect to.
            logger: Logger instance for recording operations.
            mcp_registry: Dictionary mapping MCP server names to their configuration.
                         If None, will attempt to load from registry module at runtime.
        """
        self.mcp_clients: dict[str, MCPClient] = {}
        self.mcp_servers = mcp_servers
        self.logger = logger
        self._mcp_registry = mcp_registry

    def __enter__(self) -> "MCPClientManager":
        """Context manager entry - initializes MCP clients."""
        self.init_mcp_clients()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Context manager exit - ensures connections are cleaned up."""
        self.cleanup_connections()

    def _get_mcp_registry(self) -> dict[str, dict[str, Any]]:
        """
        Get the MCP registry, loading from registry module if not provided.

        Returns:
            Dictionary mapping MCP server names to their configuration.

        Raises:
            ValueError: If no registry is available.
        """
        if self._mcp_registry is not None:
            return self._mcp_registry

        # Try to import from local registry module (for backwards compatibility)
        try:
            from .registry import AVAILABLE_MCPS  # type: ignore

            return AVAILABLE_MCPS
        except ImportError:
            raise ValueError(
                "No MCP registry provided and could not import from registry module. "
                "Please pass mcp_registry parameter to MCPClientManager."
            )

    def _create_mcp_client(self, mcp_server_name: str) -> MCPClient:
        """
        Create MCP client for a specific server.

        Args:
            mcp_server_name: Name of the MCP server to create a client for.

        Returns:
            MCPClient: The created or existing MCP client.

        Raises:
            ValueError: If the MCP server name is not in the registry.
        """
        available_mcps = self._get_mcp_registry()

        # If client exists, return the existing instance
        if mcp_server_name in self.mcp_clients:
            return self.mcp_clients[mcp_server_name]

        if mcp_server_name not in available_mcps:
            raise ValueError(
                f"Invalid MCP Server name: {mcp_server_name}. "
                f"Available MCP servers are: {list(available_mcps.keys())}"
            )

        try:
            config = available_mcps[mcp_server_name]
            mcp_url = config["McpUrl"]
            auth_type = config.get("AuthType", "SIGV4")

            self.logger.info(
                f"Initializing {mcp_server_name} MCP server with URL: {mcp_url}, AuthType: {auth_type}"
            )

            if auth_type == "NONE":
                # Plain Streamable HTTP — for public/external servers (no SigV4)
                mcp_client = MCPClient(
                    lambda url=mcp_url: streamablehttp_client(url=url),
                    prefix=mcp_server_name,
                )
            else:
                # IAM auth via mcp-proxy-for-aws for AgentCore-hosted servers
                region = os.environ.get("AWS_REGION")
                if not region:
                    raise ValueError(
                        "AWS_REGION environment variable is required for MCP client authentication"
                    )

                mcp_client = MCPClient(
                    lambda url=mcp_url, rgn=region: aws_iam_streamablehttp_client(
                        endpoint=url,
                        aws_region=rgn,
                        aws_service="bedrock-agentcore",
                    ),
                    prefix=mcp_server_name,
                )

            self.logger.info(
                f"Initialized the MCP Server named [{mcp_server_name}]",
                extra={"mcpUrl": mcp_url, "authType": auth_type},
            )
            return mcp_client
        except Exception as e:
            self.logger.error(
                f"Failed to initialize MCP Server named [{mcp_server_name}]: {e}"
            )
            raise

    def init_mcp_clients(self) -> None:
        """
        Create and start MCP clients for all configured MCP servers.

        This method initializes connections for each server in self.mcp_servers.
        If a client already exists with an active session, it will be reused.
        """
        for mcp_server_name in self.mcp_servers:
            # If client exists and has an active session, reuse it
            if mcp_server_name in self.mcp_clients:
                # Note: _is_session_active() is a private method of MCPClient.
                # This is used to check connection state; may need updating if
                # the MCPClient library changes its internal API.
                if self.mcp_clients[mcp_server_name]._is_session_active():
                    self.logger.info(
                        f"MCP client for {mcp_server_name} already exists with active session, reusing."
                    )
                    continue

            mcp_client = self._create_mcp_client(mcp_server_name)
            self.logger.info(f"Created MCP client for {mcp_server_name}")
            try:
                mcp_client.start()  # Open connection
                self.logger.info(f"Opened connection to MCP server {mcp_server_name}")
                self.mcp_clients[mcp_server_name] = mcp_client
            except Exception as e:
                self.logger.error(
                    f"Failed to open connection to MCP server {mcp_server_name}: {e}"
                )
                raise

    def cleanup_connections(self) -> None:
        """
        Close all MCP client connections and clear the client list.

        This method should be called when the manager is no longer needed
        to properly release resources. It is automatically called when
        using the class as a context manager.
        """
        if self.mcp_clients:
            for client in self.mcp_clients.values():
                # MCPClient.stop() expects __exit__ signature (exc_type, exc_val, exc_tb)
                # Passing None values indicates normal cleanup without exception
                client.stop(None, None, None)
            self.mcp_clients = {}

    def load_mcp_tools(self) -> list[Any]:
        """
        Aggregate tools from all MCP clients.

        Returns:
            list[Any]: A list of tools from all connected MCP servers.
        """
        mcp_tools: list[Any] = []

        if not self.mcp_clients:
            self.init_mcp_clients()

        for client in self.mcp_clients.values():
            mcp_tools.extend(client.list_tools_sync())

        return mcp_tools
