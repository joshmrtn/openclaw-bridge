const fs = require('fs');
const path = require('path');

test('generator.js exists', () => {
    const p = path.join(__dirname, '..', 'generator.js');
    expect(fs.existsSync(p)).toBe(true);
});
