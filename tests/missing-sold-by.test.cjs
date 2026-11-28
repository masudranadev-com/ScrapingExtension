const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

const diag = [];
const productContext = vm.createContext({ console, window: { location: { href: 'https://www.target.com/p/example' } },
  sleep: async () => {},
  findSoldByLinkWithRetries: async () => null, logFilterDiagnostic: (...args) => diag.push(args) });
vm.runInContext(section('async function discoverSellerFromCurrentProduct(', '\nasync function extractSellerContactFromCurrentPage('), productContext);

const storage = { sellerData: [], sellerNames: [{ unique_id: 'brand-1', seller_name: 'Brand' }], automationFacet: 'brand' };
const uploads = [];
const saveContext = vm.createContext({ console, keywordRunIndex: 0,
  getStorage: async (key, fallback) => storage[key] ?? fallback,
  setStorage: async values => Object.assign(storage, values),
  isMissingBusinessName: value => !value || String(value).toLowerCase().startsWith('not found'),
  isUsableSellerEmail: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')),
  hasFoundSellerEmail: seller => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(seller.email || ''),
  hasFoundSellerStatus: seller => seller.sold_by_missing === true || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(seller.email || ''),
  createSignalDockClient: async seller => { uploads.push(seller); return { success: true }; },
  queueSignalDockClient: async () => { throw new Error('Unexpected queued upload'); }
});
vm.runInContext(section('async function saveSellerData(', '\nasync function logSellerDataAsJSON('), saveContext);

(async () => {
  const result = await productContext.discoverSellerFromCurrentProduct('brand-1', 1, 'test');
  assert.equal(result.sellerData.email, '');
  assert.equal(result.sellerData.error_reason, 'Sold & Shipped not found');
  assert.equal(result.sellerData.sold_by_missing, true);
  assert.equal(diag[0][0], 'product-sold-by-not-found');
  await saveContext.saveSellerData(result.sellerData);
  assert.equal(storage.sellerData[0].status, 'Completed');
  assert.equal(storage.sellerNames[0].status, 'Completed');
  assert.equal(storage.sellerData[0].error_reason, 'Sold & Shipped not found');
  assert.equal(uploads.length, 0);
  await saveContext.saveSellerData({ unique_id: 'brand-1', email: 'real@example.com', business_name: 'Actual Seller' });
  assert.equal(storage.sellerData[0].is_placeholder_email, false);
  assert.equal(storage.sellerData[0].sold_by_missing, false);
  assert.equal(storage.sellerData[0].error_reason, '');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].seller_name, 'Actual Seller');
  console.log('Missing seller fallback, completion, and upload behavior passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
