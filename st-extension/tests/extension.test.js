const fs = require('fs');
const path = require('path');

test('st-extension index.js exists', () => {
    const p = path.join(__dirname, '..', 'index.js');
    expect(fs.existsSync(p)).toBe(true);
});
