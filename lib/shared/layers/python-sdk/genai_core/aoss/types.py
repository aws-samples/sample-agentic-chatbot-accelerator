# ------------------------------------------------------------------------ #
# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

# SPDX-License-Identifier: MIT-0
#
# Helper functions for OpenSearch Serverless
# ------------------------------------------------------------------------ #
from enum import Enum

from pydantic import BaseModel, computed_field


class Precision(Enum):
    BINARY = "binary"
    FLOAT = "float"


class DistanceType(Enum):
    EUCLIDEAN = "l2"
    HAMMING = "hamming"


class VectorDatabaseConfiguration(BaseModel):
    dimension: int
    precision: Precision
    distance_type: DistanceType

    @computed_field
    def precision_for_kb(self) -> str:
        return "BINARY" if self.precision == Precision.BINARY else "FLOAT32"


class MetadataManagementField(BaseModel):
    field: str
    data_type: str
    filterable: bool

    @computed_field
    def filterable_as_str(self) -> str:
        return "true" if self.filterable else "false"
