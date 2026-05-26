module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '<rootDir>/st-plugin/tests/**/*.test.js',
        '<rootDir>/st-plugin/tests/**/*.js',
        '<rootDir>/st-extension/tests/**/*.test.js',
        '<rootDir>/st-extension/tests/**/*.js'
    ],
    testPathIgnorePatterns: [
        '<rootDir>/st-plugin/tests/e2e/',
    ],
    verbose: true,
    testTimeout: 20000,
};
