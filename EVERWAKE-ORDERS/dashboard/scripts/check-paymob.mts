// The signed text must match Paymob's documented example exactly
// ("HMAC Transaction Callback": the sample processed callback and its string).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { factsFromGet, factsFromPost, getReader, intentionBody, postReader, signedText } from '../src/lib/paymob-core.ts';

const sample = {
  id: 192036465, pending: false, amount_cents: 100000, success: true, is_auth: false, is_capture: false,
  is_standalone_payment: true, is_voided: false, is_refunded: false, is_3d_secure: true, integration_id: 4097558,
  has_parent_transaction: false, order: { id: 217503754, merchant_order_id: 'abc123def456' }, created_at: '2024-06-13T11:33:44.592345',
  currency: 'EGP', source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' }, error_occured: false, owner: 302852,
  data: { message: 'Approved' }
};
const documented = '1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue';
assert.equal(signedText(postReader(sample)), documented);

// the redirect carries the same values as query parameters
const q = new URLSearchParams({ amount_cents: '100000', created_at: '2024-06-13T11:33:44.592345', currency: 'EGP', error_occured: 'false',
  has_parent_transaction: 'false', id: '192036465', integration_id: '4097558', is_3d_secure: 'true', is_auth: 'false', is_capture: 'false',
  is_refunded: 'false', is_standalone_payment: 'true', is_voided: 'false', order: '217503754', owner: '302852', pending: 'false',
  'source_data.pan': '2346', 'source_data.sub_type': 'MasterCard', 'source_data.type': 'card', success: 'true', merchant_order_id: 'abc123def456' });
assert.equal(signedText(getReader(q)), documented);

const secret = 'TESTSECRET';
assert.equal(createHmac('sha512', secret).update(signedText(postReader(sample))).digest('hex').length, 128);

const f = factsFromPost(sample);
assert.deepEqual([f.merchant_order_id, f.provider_order_id, f.transaction_id, f.success, f.amount_cents, f.card_last4, f.card_brand],
                 ['abc123def456', 217503754, 192036465, true, 100000, '2346', 'MasterCard']);
const g = factsFromGet(q);
assert.deepEqual([g.merchant_order_id, g.provider_order_id, g.success, g.amount_cents], ['abc123def456', 217503754, true, 100000]);

const body = intentionBody({ ok: true, ref: 'r1', order_no: 'NG-1', amount: 590, amount_cents: 59000, currency: 'EGP', secret_key: 's',
  public_key: 'p', integration_ids: [1], expiration: 3600, billing: { first_name: 'a' }, items: [{ name: 'x', amount: 59000, quantity: 1 }],
  notification_url: 'https://d/api/pay/paymob/t', redirection_url: 'https://d/p/r1/done', short_url: 'https://d/p/r1' });
assert.equal(body.special_reference, 'r1');
assert.equal(body.amount, 59000);
assert.equal(body.items.reduce((s, i) => s + i.amount * i.quantity, 0), body.amount, 'the lines add up to the amount');
console.log('paymob ok: signed text matches the documented example');
