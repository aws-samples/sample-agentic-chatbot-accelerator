module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/test"],
    testMatch: ["**/*.test.ts"],
    // *.slow.test.ts files synthesize AcaStack repeatedly, re-bundling every Lambda each
    // time (~15 min). Run them with `npm run test:slow`, not on the default PR loop.
    testPathIgnorePatterns: ["/node_modules/", "\\.slow\\.test\\.ts$"],
    transform: {
        "^.+\\.tsx?$": "ts-jest",
    },
};
