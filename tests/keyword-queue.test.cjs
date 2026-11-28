const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const data = {};
const events = {};
const event = name => ({ addListener(fn) { events[name] = fn; }, removeListener() {} });
let currentUrl = 'https://www.target.com/';
const availableTabs = new Set([7, 8]);
const chrome = {
  runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
  alarms: { create() {}, onAlarm: event('alarm') },
  tabs: {
    onUpdated: event('updated'), onRemoved: event('removed'),
    async update(id, options) { assert.ok(availableTabs.has(id)); currentUrl = options.url; },
    async get(id) { if (!availableTabs.has(id)) throw new Error('Tab closed'); return { id, url: currentUrl }; },
    sendMessage(id, message, callback) { if (callback) callback(); },
    remove(id, callback) { if (callback) callback(); }
  },
  storage: { local: {
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = data[key];
      return result;
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  } }
};
vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), {
  chrome, console, URL, AbortController, setTimeout, clearTimeout, fetch, crypto: webcrypto
});
function message(action, values = {}, fromTab = false) {
  return new Promise(resolve => {
    const sender = fromTab ? { tab: { id: 7, url: currentUrl } } : {};
    assert.equal(events.message({ action, ...values }, sender, resolve), true);
  });
}

(async () => {
  data.sellerData = [
    { unique_id: 'placeholder', email: 'admin@mrinfinityx.com', is_placeholder_email: true },
    { unique_id: 'real', email: 'admin@mrinfinityx.com', is_placeholder_email: false }
  ];
  data.sellerNames = [{ unique_id: 'placeholder', status: 'Found' }];
  data.keywordResults = [{ sellers: [{ email: 'admin@mrinfinityx.com', is_placeholder_email: true }] }];
  events.installed();
  await message('KEYWORD_PAGE_READY', {}, true);
  assert.equal(data.sellerData[0].email, '');
  assert.equal(data.sellerData[0].sold_by_missing, true);
  assert.equal(data.sellerNames[0].status, 'Completed');
  assert.equal(data.sellerData[1].email, 'admin@mrinfinityx.com');
  assert.equal(data.keywordResults[0].sellers[0].email, '');
  delete data.keywordResults;
  assert.equal((await message('KEYWORD_START', { tabId: 7 })).success, true);
  assert.equal(new URL(currentUrl).searchParams.get('searchTerm'), 'Trending Products');
  assert.equal((await message('FILTER_DIAGNOSTIC', { entry: { stage: 'apply-click', stageName: 'option', optionName: 'Example Brand', attempt: 1 } }, true)).success, true);
  assert.equal(data.filterDiagnostics[0].stage, 'apply-click');
  assert.equal(data.filterDiagnostics[0].applyStage, 'option');
  assert.equal(data.filterDiagnostics[0].optionName, 'Example Brand');
  const first = await message('KEYWORD_PAGE_READY', {}, true);
  assert.equal(first.success, true);
  data.sellerData = [{ unique_id: 'one', email: 'seller@example.com' }];
  assert.equal((await message('KEYWORD_COMPLETE', { index: first.index, runId: first.runId }, true)).success, true);
  assert.equal(data.keywordResults[0].sellers[0].unique_id, 'one');
  assert.equal(new URL(currentUrl).searchParams.get('searchTerm'), 'Best Selling Products');
  const second = await message('KEYWORD_PAGE_READY', {}, true);
  assert.equal((await message('KEYWORD_ERROR', { index: second.index, runId: second.runId, error: 'test failure' }, true)).success, true);
  assert.equal(data.keywordQueue.status, 'paused');
  assert.equal(data.keywordQueue.index, 1);
  data.automationAttemptedSellerIds = ['already-processed'];
  assert.equal((await message('KEYWORD_START', { tabId: 7 })).success, true);
  assert.equal(data.automationAttemptedSellerIds[0], 'already-processed');
  assert.equal(new URL(currentUrl).searchParams.get('searchTerm'), 'Best Selling Products');
  assert.equal((await message('KEYWORD_COMPLETE', { index: second.index, runId: second.runId }, true)).success, false);
  const staleProduct = await message('PROCESS_TARGET_PRODUCT_V9', { runId: second.runId, productUrl: 'https://www.target.com/p/example' }, true);
  assert.equal(staleProduct.success, false);
  const current = await message('KEYWORD_PAGE_READY', {}, true);
  const staleHeartbeat = await message('AUTOMATION_WATCHDOG_UPDATE_V11', { runId: second.runId, stage: 'manual-start', desiredRunning: true }, true);
  assert.equal(staleHeartbeat.stopped, true);
  assert.equal((await message('KEYWORD_ERROR', { index: current.index, runId: current.runId, error: 'still running' }, true)).success, true);
  assert.equal(data.keywordQueue.status, 'paused');
  await message('KEYWORD_START', { tabId: 7 });
  events.removed(7);
  assert.equal((await message('KEYWORD_PAGE_READY', {}, true)).success, false);
  assert.match(data.keywordQueue.error, /tab was closed/);
  await message('KEYWORD_START', { tabId: 7 });
  const oldRunId = data.keywordQueue.runId;
  data.sellerData = [{ unique_id: 'preserved', email: 'preserved@example.com' }];
  data.automationWatchdog.lastHeartbeat = Date.now() - 4 * 60 * 1000;
  await events.alarm({ name: 'target-mail-hunter-watchdog' });
  assert.equal(data.keywordQueue.autoRestartCount, 1);
  assert.equal((await message('AUTOMATION_WATCHDOG_UPDATE_V11', { runId: data.keywordQueue.runId, stage: 'seller-completed', desiredRunning: true }, true)).success, true);
  assert.equal(data.keywordQueue.autoRestartCount, 0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    data.automationWatchdog.lastHeartbeat = Date.now() - 4 * 60 * 1000;
    await events.alarm({ name: 'target-mail-hunter-watchdog' });
    assert.equal(data.keywordQueue.status, 'running');
    assert.equal(data.keywordQueue.autoRestartCount, attempt);
    assert.equal(data.keywordQueue.index, 1);
    assert.equal(data.automationAttemptedSellerIds[0], 'already-processed');
    assert.equal(data.sellerData[0].unique_id, 'preserved');
  }
  assert.notEqual(data.keywordQueue.runId, oldRunId);
  data.automationWatchdog.lastHeartbeat = Date.now() - 4 * 60 * 1000;
  await events.alarm({ name: 'target-mail-hunter-watchdog' });
  assert.equal(data.keywordQueue.status, 'paused');
  assert.match(data.keywordQueue.error, /restart limit/);
  await message('KEYWORD_RESTART', { tabId: 7 });
  assert.equal(data.keywordQueue.autoRestartCount, 0);
  await events.alarm({ name: 'target-mail-hunter-watchdog' });
  assert.equal(data.keywordQueue.status, 'running');
  const beforeManualRestart = data.keywordQueue.runId;
  assert.equal((await message('KEYWORD_RESTART', { tabId: 7 })).success, true);
  assert.notEqual(data.keywordQueue.runId, beforeManualRestart);
  assert.equal(data.keywordQueue.index, 1);
  assert.equal(data.sellerData[0].unique_id, 'preserved');
  assert.equal((await message('KEYWORD_COMPLETE', { index: 1, runId: beforeManualRestart }, true)).success, false);
  availableTabs.delete(7);
  assert.equal((await message('KEYWORD_RESTART', { tabId: 8 })).success, true);
  assert.equal(data.keywordQueue.tabId, 8);
  availableTabs.delete(8);
  const missingTab = await message('KEYWORD_RESTART', { tabId: 7 });
  assert.equal(missingTab.success, false);
  assert.equal(data.keywordQueue.status, 'paused');
  assert.equal(data.keywordQueue.index, 1);
  assert.equal(data.sellerData[0].unique_id, 'preserved');
  availableTabs.add(7);
  assert.equal((await message('KEYWORD_RESTART', { tabId: 7 })).success, true);
  assert.equal(data.keywordQueue.tabId, 7);
  await message('KEYWORD_STOP');
  assert.equal(data.keywordQueue.status, 'paused');
  await message('KEYWORD_RESET');
  assert.equal(data.keywordQueue, undefined);
  assert.equal(data.keywordResults.length, 1);
  await message('KEYWORD_START', { tabId: 7 });
  assert.equal(new URL(currentUrl).searchParams.get('searchTerm'), 'Trending Products');
  for (let i = 0; i < 20; i++) {
    const ready = await message('KEYWORD_PAGE_READY', {}, true);
    assert.equal(ready.index, i);
    assert.equal((await message('KEYWORD_COMPLETE', { index: i, runId: ready.runId }, true)).success, true);
  }
  assert.equal(data.keywordQueue.status, 'completed');
  assert.equal((await message('KEYWORD_START', { tabId: 7 })).success, false);
  console.log('Keyword queue transitions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
