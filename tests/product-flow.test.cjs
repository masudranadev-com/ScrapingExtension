const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

const product = (href, excluded = false) => ({ href, closest: () => excluded ? {} : null });
const products = [product('https://www.target.com/p/one/-/A-123'),
  product('https://www.target.com/p/one/-/A-123?ref=duplicate'),
  product('https://example.com/p/not-target'), product('https://www.target.com/p/hidden', true),
  product('https://www.target.com/p/two/-/A-456')];
const linkContext = vm.createContext({ URL, window: { location: { href: 'https://www.target.com/s' } },
  document: { querySelectorAll: selector => selector.startsWith('main ') ? products : [] } });
vm.runInContext(section('function findProductLinks()', '\nasync function waitForProductLinks('), linkContext);
const links = vm.runInContext('findProductLinks()', linkContext);
assert.deepEqual(Array.from(links), [products[0].href, products[4].href]);

const statusContext = vm.createContext({ console });
vm.runInContext(section('function hasFoundSellerEmail(', '\nfunction createSignalDockClient('), statusContext);
vm.runInContext(section('function normalizeSellerName(', '\nasync function getSignalDockClientNames('), statusContext);
vm.runInContext(section('function applySignalDockResult(', '\nasync function refreshCachedSignalDockStatuses('), statusContext);
assert.equal(statusContext.hasFoundSellerStatus({ status: 'Found', email: 'Sold & shipped by not found' }), false);
const brandRows = [{ seller_name: 'Example Brand', email: 'Not found' }];
statusContext.applySignalDockResult(brandRows, { success: true, names: ['Example Brand'] }, 'brand');
assert.equal(brandRows[0].status, 'Not Found');

let calls = [];
let responses = [];
const context = vm.createContext({ console, shouldStopAutomation: false, reportAutomationProgress() {}, logFilterDiagnostic() {}, sleep: async () => {},
  isUsableSellerEmail: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  collectSellerFromProductUrl: async url => { calls.push(url); const result = responses.shift(); if (result instanceof Error) throw result; return result; } });
vm.runInContext(section('async function collectSellerFromProducts(', '\nasync function saveApplyResumeCheckpoint('), context);
const collect = (urls) => context.collectSellerFromProducts(urls, 'id', 1);

(async () => {
  responses = [{ email: 'Sold & shipped by not found' }, { email: 'seller@example.com' }];
  const seller = await collect(['first', 'second']);
  assert.equal(seller.email, 'seller@example.com');
  assert.deepEqual(calls, ['first', 'second']);
  calls = [];
  const missing = { email: '', sold_by_missing: true, error_reason: 'Sold & Shipped not found' };
  responses = [missing, { email: 'actual@example.com' }];
  const recovered = await collect(['first', 'second']);
  assert.equal(recovered.email, 'actual@example.com');
  assert.deepEqual(calls, ['first', 'second']);
  calls = [];
  responses = [missing, missing];
  const fallback = await collect(['first', 'second']);
  assert.equal(fallback.sold_by_missing, true);
  assert.equal(fallback.email, '');
  assert.equal(fallback.error_reason, 'Sold & Shipped not found');
  assert.deepEqual(calls, ['first', 'second']);
  calls = [];
  responses = [missing, missing];
  assert.equal((await collect(['only'])).sold_by_missing, true);
  assert.deepEqual(calls, ['only', 'only']);
  calls = [];
  responses = [missing, new Error('network failed')];
  await assert.rejects(collect(['first', 'second']), /network failed/);
  assert.deepEqual(calls, ['first', 'second']);
  calls = [];
  responses = [{ email: 'Not found' }, new Error('page failed')];
  await assert.rejects(collect(['first', 'second']), /Could not collect a seller email/);
  assert.equal(calls.length, 2);
  console.log('Product discovery and seller-email fallback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
