# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

# SPDX-License-Identifier: MIT-0
#
# Helper functions for OpenSearch Serverless
# ------------------------------------------------------------------------ #
from __future__ import annotations

from typing import TYPE_CHECKING, Mapping, Sequence, Union

import boto3
from genai_core.exceptions import FailedIndexCreation, FailedIndexDeletion
from opensearchpy import (
    AWSV4SignerAuth,
    OpenSearch,
    OpenSearchException,
    RequestsHttpConnection,
)

from .types import (
    MetadataManagementField,
    VectorDatabaseConfiguration,
)

if TYPE_CHECKING:
    from logging import Logger as StdLogger

    from aws_lambda_powertools import Logger


class IndexManager:
    __vector_field_name__ = "bedrock-knowledge-base-default-vector"
    __text_chunk_name__ = "AMAZON_BEDROCK_TEXT_CHUNK"
    __metadata_name__ = "AMAZON_BEDROCK_METADATA"

    def __init__(
        self, collection_id: str, aws_region: str, logger: Union[Logger, StdLogger]
    ):
        os_endpoint = f"{collection_id}.{aws_region}.aoss.amazonaws.com"
        self._collection_id = collection_id
        self._client = OpenSearch(
            hosts=[
                {
                    "host": os_endpoint,
                    "port": 443,
                }
            ],
            http_auth=AWSV4SignerAuth(
                boto3.Session().get_credentials(), aws_region, "aoss"
            ),
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            pool_maxsize=10,
        )
        self._logger = logger

    def index_exists(self, index_name: str) -> bool:
        """Check if an index exists in the OpenSearch collection.

        Args:
            index_name (str): Name of the index to check for existence

        Returns:
            bool: True if the index exists, False otherwise
        """
        exists = bool(self._client.indices.exists(index_name))
        self._logger.info(f"Does index {index_name} exist? {exists}")
        return exists

    def create_index(
        self, index_name: str, config: VectorDatabaseConfiguration
    ) -> None:
        """Create a new index in the OpenSearch collection.

        Args:
            index_name (str): Name of the index to create
            config (VectorDatabaseConfiguration): Configuration for the vector database including
                dimension, precision and distance type settings

        Returns:
            None
        """
        if self.index_exists(index_name):
            self._logger.info(
                f"The index {index_name} exists already in collection {self._collection_id}"
            )
            return

        try:
            metadata_definition = [
                MetadataManagementField(
                    field=self.__text_chunk_name__, data_type="text", filterable=True
                ),
                MetadataManagementField(
                    field=self.__metadata_name__, data_type="text", filterable=False
                ),
            ]
            mapping = self._create_mapping(config, metadata_definition)
            self._logger.info(mapping)
            setting = self._create_setting()
            self._logger.info(setting)

            self._client.indices.create(
                index_name,
                body={
                    "settings": setting,
                    "mappings": mapping,
                },
                params={"wait_for_active_shards": "all"},
            )
            self._logger.info(
                f"Successfully started the creation of index {index_name}"
            )

        except OpenSearchException as err:
            self._logger.error(f"Error creating index: {err}")
            self._logger.exception(err)
            raise FailedIndexCreation() from err

    def delete_index(self, index_name: str) -> bool:
        """Delete an index from the OpenSearch collection.

        Args:
            index_name (str): Name of the index to delete

        Returns:
            bool: True if index was successfully deleted, False otherwise
        """
        successful = False
        try:
            if not self.index_exists(index_name):
                self._logger.info(f"Index {index_name} does not exist")
                return successful

            self._client.indices.delete(index=index_name)
            self._logger.info(f"Successfully deleted index {index_name}")
            successful = True

        except OpenSearchException as err:
            self._logger.error(f"Error deleting index: {err}")
            self._logger.exception(err)
            raise FailedIndexDeletion() from err
        return successful

    @classmethod
    def _create_mapping(
        cls,
        config: VectorDatabaseConfiguration,
        metadata_definition: Sequence[MetadataManagementField],
    ) -> Mapping:
        mapping = {
            "properties": {
                cls.__vector_field_name__: {
                    "type": "knn_vector",
                    "dimension": config.dimension,
                    "data_type": config.precision.value,
                    "method": {
                        "engine": "faiss",
                        "space_type": config.distance_type.value,
                        "name": "hnsw",
                        "parameters": {},
                    },
                },
                "id": {
                    "type": "text",
                    "fields": {"keyword": {"type": "keyword", "ignore_above": 256}},
                },
            },
        }
        for metadata in metadata_definition:
            mapping["properties"][metadata.field] = {
                "type": metadata.data_type,
                "index": metadata.filterable_as_str,
            }
        return mapping

    @staticmethod
    def _create_setting() -> Mapping:
        return {
            "index": {
                "number_of_shards": "2",
                "knn.algo_param": {"ef_search": "512"},
                "knn": "true",
            },
        }
