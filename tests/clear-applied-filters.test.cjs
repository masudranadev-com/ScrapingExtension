const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function getAppliedFilterButtons()');
const end = source.indexOf('\nasync function openFiltersAndSellerPanel(', start);
assert.ok(start >= 0 && end > start);
const code = source.slice(start, end);

function fixture(names, options = {}) {
  let now = 0;
  let buttons = names.map(name => ({ name, textContent: name, disabled: false, isConnected: true,
    closest: () => null, getClientRects: () => [1],
    getAttribute: key => key === 'data-test' ? `applied-facet-button-${name}` : key === 'aria-label' ? `${name} applied` : null }));
  const clicks = [], diagnostics = [];
  const context = vm.createContext({ Date: { now: () => now }, shouldStopAutomation: false,
    document: { querySelectorAll: () => buttons },
    sleep: async ms => { now += ms; }, reportAutomationProgress() {},
    logFilterDiagnostic: (stage, details) => diagnostics.push({ stage, ...details }),
    scrollToAndClick: button => { clicks.push(button.name); if (!options.stuck) buttons = buttons.filter(item => item !== button); } });
  vm.runInContext(code, context);
  return { context, clicks, diagnostics, getButtons: () => buttons };
}

(async () => {
  const empty = fixture([]);
  assert.equal(await empty.context.clearAppliedFilters(), true);
  assert.deepEqual(empty.clicks, []);
  const multiple = fixture(['NUTRICHEF', 'Other']);
  assert.equal(await multiple.context.clearAppliedFilters(), true);
  assert.deepEqual(multiple.clicks, ['NUTRICHEF', 'Other']);
  assert.equal(multiple.getButtons().length, 0);
  const stuck = fixture(['NUTRICHEF'], { stuck: true });
  await assert.rejects(stuck.context.clearAppliedFilters(), /Could not remove applied filter/);
  assert.deepEqual(stuck.clicks, ['NUTRICHEF', 'NUTRICHEF']);
  assert.ok(stuck.diagnostics.some(entry => entry.stage === 'remove-applied-filter-failed'));
  const stopped = fixture(['NUTRICHEF']);
  stopped.context.shouldStopAutomation = true;
  assert.equal(await stopped.context.clearAppliedFilters(), false);
  assert.deepEqual(stopped.clicks, []);
  console.log('Applied-filter cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
