const loader = require('../character-loader');

test('listCharacters returns parsed Rowan', async () => {
    const chars = await loader.listCharacters();
    expect(Array.isArray(chars)).toBe(true);

    const rowan = chars.find(c => c && (c.name === 'Rowan' || (c.meta && c.meta.name === 'Rowan')));
    expect(rowan).toBeDefined();
    // rowan may expose name at top-level or under meta.name depending on loader
    expect((rowan.name === 'Rowan') || (rowan.meta && rowan.meta.name === 'Rowan')).toBeTruthy();
});
