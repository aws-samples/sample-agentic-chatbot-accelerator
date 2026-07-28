// Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
//
// SPDX-License-Identifier: MIT-0

import {
    assertRegionSupported,
    modelsForRegion,
    SUPPORTED_MODELS,
} from "../lib/shared/supported-models";

// A region deliberately absent from SUPPORTED_MODELS, obviously fake so it can
// never accidentally match a real seeded region.
const UNSUPPORTED_REGION = "xx-nowhere-1";

// Pick the first seeded region as the "supported" fixture so the test tracks the
// seed rather than hard-coding a region name.
const SUPPORTED_REGION = Object.keys(SUPPORTED_MODELS)[0];

describe("modelsForRegion", () => {
    it("returns the flat display→id map for a supported region", () => {
        const slice = modelsForRegion(SUPPORTED_REGION);
        expect(slice).toEqual(SUPPORTED_MODELS[SUPPORTED_REGION]);
        // Every value is a literal id — no leftover substitution token.
        for (const id of Object.values(slice)) {
            expect(id).not.toContain("[REGION-PREFIX]");
        }
    });

    it("throws (listing supported regions) for an unsupported region", () => {
        expect(() => modelsForRegion(UNSUPPORTED_REGION)).toThrow(/supported regions/i);
    });
});

describe("assertRegionSupported", () => {
    it("passes for a supported region", () => {
        expect(() => assertRegionSupported(SUPPORTED_REGION)).not.toThrow();
    });

    it("throws for an unsupported region, naming supported regions", () => {
        expect(() => assertRegionSupported(UNSUPPORTED_REGION)).toThrow(
            new RegExp(SUPPORTED_REGION),
        );
    });

    it("throws for undefined (unset env)", () => {
        expect(() => assertRegionSupported(undefined)).toThrow(/not set/i);
    });
});
