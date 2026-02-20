# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# SPDX-License-Identifier: MIT-0
# ------------------------------------------------------------------------ #
import os
from logging import Logger
from typing import Any

from boto3 import Session
from strands.tools.mcp.mcp_client import MCPClient

from .mcp_auth import streamablehttp_client_with_sigv4

# Boto3 session for AWS credential management
SESSION = Session()


class MCPClientManager:
    """
    Manages MCP (Model Context Protocol) client connections.

    This class handles the lifecycle of MCP clients including creation,
    connection management, and tool aggregation from multiple MCP servers.

    Usage:
        manager = MCPClientManager(mcp_servers=["server1"], logger=logger)
        with manager:
            tools = manager.load_mcp_tools()
    """

    def __init__(self, mcp_servers: list[str], logger: Logger) -> None:
        self.mcp_clients: dict[str, MCPClient] = {}
        self.mcp_servers = mcp_servers
        self.logger = logger

    def __enter__(self) -> "MCPClientManager":
        """Context manager entry - initializes MCP clients."""
        self.init_mcp_clients()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Context manager exit - ensures connections are cleaned up."""
        self.cleanup_connections()

    def _get_credentials(self):
        """
        Get fresh AWS credentials from the session.

        This method fetches credentials on each call to handle credential
        refresh for long-running processes where credentials may expire.
        """
        return SESSION.get_credentials()

    def _create_mcp_client(self, mcp_server_name: str) -> MCPClient:
        """
        Create MCP client for a specific server.

        Args:
            mcp_server_name: Name of the MCP server to create a client for.

        Returns:
            MCPClient: The created or existing MCP client.

        Raises:
            ValueError: If the MCP server name is not in AVAILABLE_MCPS.
        """
        # Import here to avoid circular dependency between mcp_client and registry modules
        from .registry import AVAILABLE_MCPS

        # If client exists, return the existing instance
        if mcp_server_name in self.mcp_clients:
            return self.mcp_clients[mcp_server_name]

        if mcp_server_name not in AVAILABLE_MCPS:
            raise ValueError(
                f"Invalid MCP Server name: {mcp_server_name}. "
                f"Available MCP servers are: {list(AVAILABLE_MCPS.keys())}"
            )

        try:
            mcp_url = AVAILABLE_MCPS[mcp_server_name]["McpUrl"]
            self.logger.info(
                f"Initializing {mcp_server_name} MCP server with URL: {mcp_url}"
            )

            region = os.environ.get("AWS_REGION")
            if not region:
                raise ValueError(
                    "AWS_REGION environment variable is required for MCP client authentication"
                )

            # Capture mcp_url and region in closure; credentials fetched fresh on each connection
            # to handle credential refresh for long-running processes
            mcp_client = MCPClient(
                lambda url=mcp_url, rgn=region: streamablehttp_client_with_sigv4(
                    url=url,
                    credentials=self._get_credentials(),
                    service="bedrock-agentcore",
                    region=rgn,
                ),
                prefix=mcp_server_name,
            )

            self.logger.info(
                f"Initialized the MCP Server named [{mcp_server_name}]",
                extra={"mcpUrl": mcp_url},
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
