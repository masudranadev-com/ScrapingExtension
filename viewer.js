let allData = [];
let filteredData = [];
let categoryName = '';
let totalSellers = 0;
let sellerNames = [];
let newSellerCount = 0;
let clientNameCheckSucceeded = null;
let clientNameCheckError = '';

// Load data on page load
window.addEventListener('DOMContentLoaded', loadData);

// Keep the table current while content.js discovers and processes sellers.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes.sellerNames || changes.sellerData || changes.totalSellers || changes.newSellers || changes.clientNameCheckSucceeded || changes.clientNameCheckError || changes.categoryName || changes.breadcrumbSteps)
  ) {
    loadData();
  }
});

// Search functionality
const searchBox = document.getElementById('searchBox');
const tableBody = document.getElementById('tableBody');

searchBox.placeholder = 'Search by business name, email, phone, or seller ID...';

searchBox.addEventListener('input', () => {
  applySearch();
  renderTable();
});

tableBody.addEventListener('click', (e) => {
  const removeButton = e.target.closest('.btn-remove');
  if (!removeButton) return;

  const index = Number(removeButton.dataset.index);
  removeSeller(index);
});

function applySearch() {
  const query = searchBox.value.trim().toLowerCase();
  if (query === '') {
    filteredData = allData;
  } else {
    filteredData = allData.filter(seller => {
      return (
        (seller.seller_name && seller.seller_name.toLowerCase().includes(query)) ||
        (seller.business_name && seller.business_name.toLowerCase().includes(query)) ||
        (seller.email && seller.email.toLowerCase().includes(query)) ||
        (seller.mobile_number && seller.mobile_number.toLowerCase().includes(query)) ||
        (seller.error_reason && seller.error_reason.toLowerCase().includes(query)) ||
        (seller.unique_id && seller.unique_id.toLowerCase().includes(query))
      );
    });
  }
}

// Refresh button
document.getElementById('refreshData').addEventListener('click', loadData);

// Download JSON
document.getElementById('downloadJSON').addEventListener('click', () => {
  const prefix = getFilePrefix();
  downloadFile(JSON.stringify(allData, null, 2), `${prefix}.json`, 'application/json');
});

// Download CSV
document.getElementById('downloadCSV').addEventListener('click', () => {
  const prefix = getFilePrefix();
  const csv = convertToCSV(allData);
  downloadFile(csv, `${prefix}.csv`, 'text/csv');
});

// Generate filename prefix from category name + date
function getFilePrefix() {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const date = `${now.getDate()}-${months[now.getMonth()]}-${now.getFullYear()}`;
  if (!categoryName) return `seller-data-${date}`;
  const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${slug}-${date}`;
}

// Clear data
document.getElementById('clearData').addEventListener('click', () => {
  if (confirm('Are you sure you want to delete ALL seller data? This cannot be undone!')) {
    chrome.storage.local.remove(['sellerNames', 'sellerData', 'currentSellerIndex', 'categoryName', 'breadcrumbSteps', 'totalSellers', 'newSellers', 'clientNameCheckSucceeded', 'clientNameCheckError', 'clientNameCheckedAt', 'sellerCatalogCategoryName', 'signalDockClientNames', 'signalDockClientNamesSucceeded', 'signalDockClientNamesError', 'signalDockClientNamesCheckedAt'], () => {
      console.log('All data cleared');
      loadData();
    });
  }
});

// Load data from chrome.storage
function loadData() {
  chrome.storage.local.get(['sellerNames', 'sellerData', 'categoryName', 'breadcrumbSteps', 'totalSellers', 'newSellers', 'clientNameCheckSucceeded', 'clientNameCheckError'], (result) => {
    const storedSellerData = Array.isArray(result.sellerData) ? result.sellerData : [];
    sellerNames = Array.isArray(result.sellerNames) ? result.sellerNames : [];
    allData = mergeSellerNamesWithData(sellerNames, storedSellerData);
    categoryName = result.categoryName || '';
    // The displayed total must come from the same rows rendered in the table.
    totalSellers = allData.length;
    newSellerCount = allData.filter((seller) => seller.is_new_seller === true).length;
    clientNameCheckSucceeded = typeof result.clientNameCheckSucceeded === 'boolean'
      ? result.clientNameCheckSucceeded
      : null;
    clientNameCheckError = result.clientNameCheckError || '';
    if (clientNameCheckSucceeded === false) {
      console.error('[SignalDock] API validation error:', clientNameCheckError);
    }
    const breadcrumbSteps = result.breadcrumbSteps || [];
    applySearch();
    renderCategoryInfo(categoryName, breadcrumbSteps);
    renderTable();
    updateStats();
  });
}

function mergeSellerNamesWithData(nameRows, dataRows) {
  if (nameRows.length === 0) return dataRows;

  const dataBySellerId = new Map(
    dataRows
      .filter((seller) => seller && seller.unique_id)
      .map((seller) => [String(seller.unique_id), seller])
  );

  const mergedRows = nameRows.map((nameRow, index) => {
    const sellerId = String(nameRow.unique_id || '');
    const collectedData = dataBySellerId.get(sellerId) || {};

    return {
      email: 'Not found',
      headquarters: 'Not found',
      mobile_number: 'Not found',
      store_link: 'Not found',
      error_reason: '',
      ...collectedData,
      id: nameRow.id || collectedData.id || index + 1,
      unique_id: nameRow.unique_id || collectedData.unique_id || '',
      seller_name: nameRow.seller_name || collectedData.seller_name || collectedData.business_name || 'Not found',
      status: collectedData.status || nameRow.status || 'Not Found',
      is_existing_client: typeof collectedData.is_existing_client === 'boolean'
        ? collectedData.is_existing_client
        : nameRow.is_existing_client === true,
      is_duplicate_seller: typeof collectedData.is_duplicate_seller === 'boolean'
        ? collectedData.is_duplicate_seller
        : nameRow.is_duplicate_seller === true,
      is_new_seller: typeof collectedData.is_new_seller === 'boolean'
        ? collectedData.is_new_seller
        : nameRow.is_new_seller === true
    };
  });

  const knownSellerIds = new Set(
    nameRows.map((seller) => String(seller.unique_id || ''))
  );
  const unmatchedData = dataRows.filter(
    (seller) => !knownSellerIds.has(String(seller.unique_id || ''))
  );

  return [...mergedRows, ...unmatchedData];
}

function hasFoundSellerEmail(seller) {
  const email = String((seller && seller.email) || '').trim().toLowerCase();
  return Boolean(email) && !email.includes('not found');
}

function hasFoundSellerStatus(seller) {
  return Boolean(
    seller && (
      String(seller.status || '').trim().toLowerCase() === 'found' ||
      seller.is_existing_client === true ||
      seller.is_duplicate_seller === true ||
      hasFoundSellerEmail(seller)
    )
  );
}

// Render category info
function renderCategoryInfo(name, steps) {
  const categoryInfo = document.getElementById('categoryInfo');
  const breadcrumbPath = document.getElementById('breadcrumbPath');
  const categoryNameDisplay = document.getElementById('categoryNameDisplay');

  if (!name && steps.length === 0) {
    categoryInfo.style.display = 'none';
    return;
  }

  categoryInfo.style.display = 'block';

  if (steps.length > 0) {
    breadcrumbPath.innerHTML = steps.map((step, i) => {
      const link = `<a href="https://www.target.com${step.href}" target="_blank">${step.name}</a>`;
      return i < steps.length - 1 ? link + '<span>›</span>' : link;
    }).join('');
  }

  if (name) {
    categoryNameDisplay.textContent = name;
  }
}

// Remove a seller by its current source index in sellerData.
function removeSeller(index) {
  if (!Number.isInteger(index) || index < 0 || index >= allData.length) return;

  allData.splice(index, 1);
  totalSellers = allData.length;
  newSellerCount = allData.filter((seller) => seller.is_new_seller === true).length;
  sellerNames = allData.map((seller, sellerIndex) => ({
    id: sellerIndex + 1,
    unique_id: seller.unique_id || '',
    seller_name: seller.seller_name || seller.business_name || 'Not found',
    status: seller.status || 'Not Found',
    is_existing_client: seller.is_existing_client === true,
    is_duplicate_seller: seller.is_duplicate_seller === true,
    is_new_seller: seller.is_new_seller === true
  }));

  chrome.storage.local.set({ sellerNames, sellerData: allData, totalSellers, newSellers: newSellerCount }, () => {
    if (chrome.runtime.lastError) {
      alert(`Failed to remove seller: ${chrome.runtime.lastError.message}`);
      loadData();
      return;
    }

    applySearch();
    renderTable();
    updateStats();
  });
}

// Render table
function renderTable() {
  const emptyState = document.getElementById('emptyState');
  const dataTable = document.getElementById('dataTable');

  if (filteredData.length === 0) {
    dataTable.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  dataTable.style.display = 'table';

  tableBody.innerHTML = filteredData.map((seller, index) => {
    const sourceIndex = allData.indexOf(seller);
    const hasFoundStatus = hasFoundSellerStatus(seller);
    const statusBadge = hasFoundStatus
      ? '<span class="badge badge-success">✓ Found</span>'
      : '<span class="badge badge-danger">✗ Not Found</span>';

    return `
      <tr data-index="${sourceIndex}">
        <td>${escapeHTML(seller.id || index + 1)}</td>
        <td><code>${escapeHTML(seller.unique_id || 'N/A')}</code></td>
        <td class="cell-long">${escapeHTML(seller.seller_name || seller.business_name || 'N/A')}</td>
        <td class="cell-long">${escapeHTML(seller.email || 'N/A')}</td>
        <td class="cell-long">${escapeHTML(seller.mobile_number || 'N/A')}</td>
        <td class="cell-long">${escapeHTML(seller.headquarters || 'N/A')}</td>
        <td>
          ${seller.store_link && !seller.store_link.includes('Not found')
            ? `<a href="${escapeHTML(seller.store_link)}" target="_blank" class="link">View Store</a>`
            : 'N/A'}
        </td>
        <td class="cell-long">${escapeHTML(seller.error_reason || 'N/A')}</td>
        <td>${statusBadge}</td>
        <td><button type="button" class="btn-remove" data-index="${sourceIndex}" title="Remove seller">&times;</button></td>
      </tr>
    `;
  }).join('');

  tableBody.querySelectorAll('.btn-remove').forEach((button, buttonIndex) => {
    const sourceIndex = allData.indexOf(filteredData[buttonIndex]);
    button.removeAttribute('onclick');
    button.type = 'button';
    button.dataset.index = sourceIndex;
    button.title = 'Remove seller';
    button.innerHTML = '&times;';
  });
}

// Update statistics
function updateStats() {
  const emailCount = allData.filter(hasFoundSellerEmail).length;
  const newSellersElement = document.getElementById('newSellers');

  if (clientNameCheckSucceeded === false) {
    newSellersElement.textContent = 'API Error';
    newSellersElement.title = clientNameCheckError || 'SignalDock client-name check failed';
  } else {
    newSellersElement.textContent = newSellerCount;
    newSellersElement.title = 'Unique seller names not returned by SignalDock';
  }
  document.getElementById('totalCount').textContent = allData.length;
  document.getElementById('emailCount').textContent = emailCount;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

// Convert to CSV
function convertToCSV(data) {
  if (data.length === 0) return '';

  const headers = ['ID', 'Seller ID', 'Business Name', 'Email', 'Mobile Number', 'Headquarters', 'Store Link', 'Error Reason'];
  const rows = data.map(seller => [
    seller.id || '',
    seller.unique_id || '',
    seller.business_name || '',
    seller.email || '',
    seller.mobile_number || '',
    seller.headquarters || '',
    seller.store_link || '',
    seller.error_reason || ''
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');

  return csvContent;
}

// Download file
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
