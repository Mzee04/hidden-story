// Offline check of how Clocked responses (shapes from the official SDK types) map to game outcomes.
import { interpretQuestion, interpretGuess } from '../server/clocked.js';
import assert from 'node:assert/strict';
const q = (choice, probabilities, confidence, k) => interpretQuestion({ type: 'choice', choice, probabilities, confidence }, k);
assert.equal(q('yes', { yes: .9, no: .05, unknown: .05 }, .9, { type: 'noul', noul: .2, decision: false }).answer, 'yes');
assert.equal(q('no', { yes: .1, no: .85, unknown: .05 }, .85).answer, 'no');
assert.equal(q('yes', { yes: .5, no: .1, unknown: .4 }, .5).answer, 'unknown', 'low confidence -> unknown');
assert.equal(q('yes', { yes: .58, no: .45, unknown: 0 }, .58).answer, 'unknown', 'close split -> unknown');
assert.equal(q('yes', { yes: .9, no: .05, unknown: .05 }, .9, { type: 'noul', noul: .9, decision: true }).keyDetail, true);
assert.equal(q('unknown', { yes: .1, no: .1, unknown: .8 }, .8, { type: 'noul', noul: .9, decision: true }).keyDetail, false);
assert.equal(interpretGuess({ type: 'noul', noul: .92, decision: true }).correct, true);
assert.equal(interpretGuess({ type: 'noul', noul: .79, decision: false }).correct, false);
assert.equal(interpretGuess({ type: 'noul', noul: .6, decision: false }).close, true);
assert.equal(interpretGuess({ type: 'noul', noul: .85 }).correct, true, 'no decision field -> threshold on noul');
console.log('interpret tests passed');

// Malformed responses never throw for questions and never award a win.
import { interpretGuard } from '../server/clocked.js';
assert.equal(interpretQuestion(undefined).answer, 'unknown');
assert.equal(interpretQuestion(null, null).answer, 'unknown');
assert.equal(interpretQuestion({ choice: 'maybe', probabilities: {}, confidence: 0.9 }).answer, 'unknown');
assert.equal(interpretQuestion({ choice: 'yes', probabilities: 'x', confidence: 'high' }).answer, 'unknown');
assert.throws(() => interpretGuess(undefined), (e) => e.code === 'MALFORMED');
assert.throws(() => interpretGuess({ noul: 'yes' }), (e) => e.code === 'MALFORMED');
assert.throws(() => interpretGuard({}), (e) => e.code === 'MALFORMED');
assert.equal(interpretGuard({ verdict: 'benign', evidence: [null, { quote: 1 }] }).blocked, false);
assert.equal(interpretGuard({ verdict: 'injection', category: 'instruction override' }).blocked, true);
console.log('malformed-response tests passed');
