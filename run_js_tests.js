const fs = require('fs');
const path = require('path');

function makeExpect(actual) {
    return {
        toBe(expected) {
            if (actual !== expected) throw new Error(`toBe failed: ${actual} !== ${expected}`);
        },
        toBeDefined() {
            if (actual === undefined) throw new Error(`toBeDefined failed: value is undefined`);
        },
        toBeTruthy() {
            if (!actual) throw new Error(`toBeTruthy failed: ${actual} is not truthy`);
        }
    };
}

global.expect = makeExpect;

global.test = async function (name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') await r;
        console.log(`PASS: ${name}`);
    } catch (err) {
        console.error(`FAIL: ${name}`);
        console.error(err.stack || err.toString());
        process.exitCode = 1;
    }
};

function runTestsInDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const f of files) {
        const p = path.join(dir, f);
        console.log('RUN FILE', p);
        require(p);
    }
}

// Run st-plugin tests then st-extension tests
runTestsInDir(path.join(__dirname, 'st-plugin', 'tests'));
runTestsInDir(path.join(__dirname, 'st-extension', 'tests'));

if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
else console.log('All JS tests passed');
