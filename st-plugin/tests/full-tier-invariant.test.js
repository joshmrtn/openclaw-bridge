'use strict';

/**
 * Full-tier invariant guardrail.
 *
 * The full-tier E2E suite (docker/full/test-runner/full-e2e.test.js) exists to
 * prove the WHOLE system end-to-end: a message injected into qa-bus must travel
 * through real OC -> real ST -> fake LLM -> back to qa-bus. Calling ST's
 * /generate endpoint directly from the test runner bypasses OC and silently
 * demotes a full-tier test to a slow dockerized unit test — which is exactly the
 * coverage we already have at the unit tier.
 *
 * This guardrail runs in the always-on unit tier (so CI enforces it) and fails
 * if any direct stFetch('/generate', ...) call lacks a justification. A direct
 * call is only acceptable when the behaviour genuinely cannot be driven through
 * OC — HTTP auth/CSRF header crafting, plugin/WS-layer mechanics OC never
 * touches, induced-infra-failure resilience, or same-instant concurrency. Each
 * such call must be preceded, within its own test/hook block, by a comment:
 *
 *     // FULL-PATH-EXCEPTION: <why the qa-bus -> OC path cannot drive this>
 *
 * To clear a violation you either (preferred) rewrite the test to drive the
 * behaviour through qa-bus, or add the annotation with a real reason.
 */

const fs = require('fs');
const path = require('path');

const FULL_E2E_PATH = path.resolve(
    __dirname,
    '../../docker/full/test-runner/full-e2e.test.js',
);

// A direct call into ST's generation endpoint from the full-tier runner.
const DIRECT_GENERATE = /stFetch\(\s*['"]\/generate\b/;
// Block boundaries — the backward search for an annotation stops here so an
// annotation cannot "leak" in from a previous test.
const BLOCK_BOUNDARY = /^\s*(test|it|describe|beforeEach|beforeAll|afterEach|afterAll)\s*\(/;
const EXCEPTION_MARKER = /FULL-PATH-EXCEPTION/;
const TEST_NAME = /^\s*(?:test|it)\s*\(\s*['"`](.+?)['"`]/;

function enclosingTestName(lines, index) {
    for (let j = index; j >= 0; j--) {
        const m = lines[j].match(TEST_NAME);
        if (m) return m[1];
    }
    return '(file scope)';
}

function findViolations(source) {
    const lines = source.split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        if (!DIRECT_GENERATE.test(lines[i])) continue;
        let annotated = false;
        for (let j = i - 1; j >= 0; j--) {
            if (EXCEPTION_MARKER.test(lines[j])) { annotated = true; break; }
            if (BLOCK_BOUNDARY.test(lines[j])) break; // hit block start first
        }
        if (!annotated) {
            violations.push({ line: i + 1, test: enclosingTestName(lines, i) });
        }
    }
    return violations;
}

describe('full-tier invariant guardrail', () => {
    test('the full-tier suite file exists where the guardrail expects it', () => {
        expect(fs.existsSync(FULL_E2E_PATH)).toBe(true);
    });

    test('every direct stFetch(/generate) call in the full tier is justified with FULL-PATH-EXCEPTION', () => {
        const source = fs.readFileSync(FULL_E2E_PATH, 'utf8');
        const violations = findViolations(source);
        const report = violations
            .map(v => `  - line ${v.line} in test: "${v.test}"`)
            .join('\n');
        expect(
            violations.length === 0
                ? ''
                : `Unjustified direct /generate calls (bypass OC) in full-e2e.test.js:\n${report}\n` +
                  `Either route the behaviour through qa-bus, or add a "// FULL-PATH-EXCEPTION: <reason>" ` +
                  `comment in the same test/hook block above the call.`,
        ).toBe('');
    });
});

describe('full-tier invariant guardrail — matcher self-tests', () => {
    test('flags an unannotated direct /generate call', () => {
        const src = [
            "test('y', async () => {",
            "  const r = await stFetch('/generate', { method: 'POST' });",
            '});',
        ].join('\n');
        expect(findViolations(src)).toHaveLength(1);
        expect(findViolations(src)[0].test).toBe('y');
    });

    test('accepts a call annotated with FULL-PATH-EXCEPTION in the same block', () => {
        const src = [
            "test('x', async () => {",
            '  // FULL-PATH-EXCEPTION: reason',
            "  const r = await stFetch('/generate', { method: 'POST' });",
            '});',
        ].join('\n');
        expect(findViolations(src)).toHaveLength(0);
    });

    test('does not let an annotation leak in from a previous block', () => {
        const src = [
            "test('a', () => {",
            '  // FULL-PATH-EXCEPTION: reason',
            '});',
            "test('b', async () => {",
            "  const r = await stFetch('/generate', {});",
            '});',
        ].join('\n');
        const v = findViolations(src);
        expect(v).toHaveLength(1);
        expect(v[0].test).toBe('b');
    });
});

module.exports = { findViolations };
