/**
 * Deterministic test-file ordering.
 *
 * The split suites share one docker stack and run serially (--runInBand). Jest's
 * default sequencer orders by a timing heuristic, which is non-deterministic. The
 * numeric filename prefixes (01-…, 02-…) encode the original source order so that
 * any latent inter-suite ordering assumption is preserved; sort by path to honour it.
 */

'use strict';

const Sequencer = require('@jest/test-sequencer').default;

class AlphabeticSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = AlphabeticSequencer;
