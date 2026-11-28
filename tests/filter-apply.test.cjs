const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

const applySource = section('async function applySelectedFilter(', '\nfunction parseContactText(');
async function runApply(mode) {
  let now = 0, state = 'options';
  const clicks = [], logs = [];
  const context = vm.createContext({ shouldStopAutomation: false,
    Date: { now: () => now }, sleep: async ms => { now += ms; },
    logFilterDiagnostic: (stage, details) => logs.push({ stage, ...details }),
    reportAutomationProgress() {}, getModal: () => state === 'closed' ? null : { state },
    isFilterGroupList: modal => modal.state === 'groups',
    waitForEnabledFilterApply: async stage => ({ textContent: stage }),
    scrollToAndClick: button => {
      clicks.push(button.textContent);
      if (mode === 'one') state = 'closed';
      if (mode === 'two') state = state === 'options' ? 'groups' : 'closed';
    } });
  vm.runInContext(applySource, context);
  if (mode === 'stuck') await assert.rejects(context.applySelectedFilter('123', 'Brand'), /did not change/);
  else await context.applySelectedFilter('123', 'Brand');
  return { clicks, logs };
}

const waitSource = section('async function waitForEnabledFilterApply(', '\nfunction isFilterGroupList(');
const findSource = section('function findFilterApplyButtons(', '\nasync function waitForEnabledFilterApply(');
function button(text, disabled = false) {
  return { textContent: text, disabled, getAttribute: () => '', matches: () => disabled, closest: () => null };
}
const innerDisabled = button('Apply', true);
const portalButton = button('Apply filters');
const modal = { querySelectorAll: selector => selector.startsWith('[data-test=') ? [innerDisabled] : [innerDisabled] };
const finder = vm.createContext({ isVisibleFilterElement: () => true, document: {
  querySelectorAll: selector => selector.startsWith('[data-test=') ? [] : [portalButton]
} });
vm.runInContext(findSource, finder);
const candidates = finder.findFilterApplyButtons(modal);
assert.equal(candidates.length, 2);
assert.equal(candidates[1].element, portalButton);
assert.equal(candidates[0].disabled, true);

async function runWait(disabledFor) {
  let now = 0;
  const context = vm.createContext({ Date: { now: () => now }, shouldStopAutomation: false,
    getModal: () => ({}), sleep: async ms => { now += ms; }, logFilterDiagnostic() {},
    findFilterApplyButtons: () => [{ element: 'apply', label: 'Apply', visible: true, disabled: now < disabledFor }] });
  vm.runInContext(waitSource, context);
  return context.waitForEnabledFilterApply('option', 1000);
}

(async () => {
  assert.deepEqual((await runApply('one')).clicks, ['option']);
  assert.deepEqual((await runApply('two')).clicks, ['option', 'final']);
  const stuck = await runApply('stuck');
  assert.deepEqual(stuck.clicks, ['option', 'option']);
  assert.ok(stuck.logs.some(log => log.stage === 'apply-no-transition'));
  assert.equal(await runWait(500), 'apply');
  await assert.rejects(runWait(2000), /No visible, enabled/);
  console.log('Filter Apply transitions and delayed enablement passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
