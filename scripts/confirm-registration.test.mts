import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmRegistration } from './confirm-registration.mts';

const lifetime = { blockhash: 'synthetic-blockhash', lastValidBlockHeight: 123 };
test('rejects confirmed execution failure before checking the Provider', async () => {
  await assert.rejects(confirmRegistration('signature', lifetime,
    async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    async () => { assert.fail('must not continue after failure'); }), /transaction failed/);
});
test('rejects missing Provider after confirmation', async () => {
  await assert.rejects(confirmRegistration('signature', lifetime,
    async () => ({ value: { err: null } }), async () => false), /not created/);
});
test('passes the blockhash lifetime and requires a successful postcondition', async () => {
  let checked = false;
  await confirmRegistration('signature', lifetime, async (strategy) => {
    assert.deepEqual(strategy, { signature: 'signature', ...lifetime });
    return { value: { err: null } };
  }, async () => { checked = true; return true; });
  assert.equal(checked, true);
});
test('propagates timeout without treating it as success', async () => {
  await assert.rejects(confirmRegistration('signature', lifetime,
    async () => { throw new Error('RPC timeout'); }, async () => true), /RPC timeout/);
});
