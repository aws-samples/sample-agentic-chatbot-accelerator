// ----------------------------------------------------------------------
// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0
// ----------------------------------------------------------------------
import { generateClient } from "aws-amplify/api";

// generateClient reads the Amplify configuration per request, so a single
// module-level client is safe to create before Amplify.configure runs.
export const apiClient = generateClient();
