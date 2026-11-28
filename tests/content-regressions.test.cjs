const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return source.slice(first, last);
}

const parse = vm.runInNewContext(`(${section('function parseContactText(', '\n// --------------------\n// New tab helpers')})`);
const contact = parse('Legal Business Name: H&H Home Products\nHeadquarters: Houston, TX\nContact: help@example.com');
assert.equal(contact.businessName, 'H&H Home Products');
assert.equal(contact.email, 'help@example.com');
assert.equal(parse('Legal Business Name: Example\nHeadquarters: NY\nContact: sales+target@example.com').email, 'sales+target@example.com');

const retrySource = section('async function requestProductSellerData(', '\nasync function collectSellerFromProductUrl(');
let attempts = 0;
const context = vm.createContext({ console, setInterval, clearInterval, sleep: async () => {},
  reportAutomationProgress() {}, requestProductSellerDataOnce: async () => {
    attempts++;
    vm.runInContext('shouldStopAutomation = true; automationGeneration++', context);
    return { success: false, phase: 'stopped-by-user' };
  } });
vm.runInContext('let shouldStopAutomation = false; let automationGeneration = 0;', context);
vm.runInContext(retrySource, context);
vm.runInContext('requestProductSellerData("https://www.target.com/p/test", "seller", 1)', context)
  .then(result => {
    assert.equal(result.phase, 'stopped-by-user');
    assert.equal(attempts, 1);
    console.log('Contact parsing and stopped product request passed');
  }).catch(error => { console.error(error); process.exitCode = 1; });
