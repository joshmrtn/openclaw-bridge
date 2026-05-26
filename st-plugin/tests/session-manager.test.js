const fs = require('fs');
const path = require('path');

test('session-manager.js exists', () => {
    const p = path.join(__dirname, '..', 'session-manager.js');
    expect(fs.existsSync(p)).toBe(true);
});
