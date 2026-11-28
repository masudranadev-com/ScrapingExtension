const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

const filter = vm.runInNewContext(`(${section('function filterSellerCheckboxes(', '\nfunction applySignalDockResult(')})`);
const checkbox = (id, value) => ({ value, disabled: false, getAttribute: key => key === 'data-test' ? `facet-checkbox-${id}` : null });
assert.equal(filter([checkbox('out', 'include out of stock'), checkbox('one', 'Example Brand')]).sellerCheckboxes.length, 1);
assert.equal(filter([checkbox('one', 'Example Brand')]).sellerCheckboxes.length, 1);
assert.equal(filter([checkbox('out', 'include out of stock')]).sellerCheckboxes.length, 0);

const openSource = section('async function openFiltersAndSellerPanel(', '\nasync function recoverToProductListing(');
async function checkPanel(sold, brand, expected, saved = '') {
  const clicked = [];
  const sequence = [];
  const modal = { querySelector(selector) {
    if (selector.includes('d_sellers_all')) return sold ? 'sold' : null;
    if (selector.includes('d_brand_all')) return brand ? 'brand' : null;
    return null;
  } };
  const context = vm.createContext({ console, shouldStopAutomation: false, reportAutomationProgress() {},
    click() { sequence.push('filters'); }, clearAppliedFilters: async () => { sequence.push('clear'); return true; }, sleep: async () => {}, verifyModalOpen: async () => true,
    verifySellerPanelOpen: async () => true, getModal: () => modal,
    getStorage: async () => saved, setStorage: async () => {},
    scrollToAndClick: button => clicked.push(button) });
  vm.runInContext(openSource, context);
  const opened = await vm.runInContext('openFiltersAndSellerPanel(1)', context);
  assert.equal(opened, Boolean(expected));
  assert.deepEqual(sequence.slice(0, 2), ['clear', 'filters']);
  assert.equal(clicked[0], expected);
}
(async () => {
  await checkPanel(true, true, 'sold');
  await checkPanel(false, true, 'brand');
  await checkPanel(true, true, 'brand', 'brand');
  await checkPanel(false, true, undefined, 'sold-by');
  await checkPanel(false, false, undefined);
  console.log('Sold by preference and Brand fallback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
