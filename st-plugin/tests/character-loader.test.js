const loader = require('../character-loader');

test('listCharacters returns sample character from fixtures', async () => {
    const fixturesDir = require('path').join(__dirname, 'fixtures');
    const chars = await loader.listCharacters(fixturesDir);
    expect(Array.isArray(chars)).toBe(true);
    const sample = chars.find(c => c && c.name === 'Sample');
    expect(sample).toBeDefined();
    expect(sample.chid).toBe(0);
});
