let allData = [];
let filteredData = [];
let categoryName = '';
let totalSellers = 0;

// Load data on page load
window.addEventListener('DOMContentLoaded', loadData);

// Search functionality
document.getElementById('searchBox').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  if (query === '') {
    filteredData = allData;
  } else {
    filteredData = allData.filter(seller => {
      return (
        (seller.business_name && seller.business_name.toLowerCase().includes(query)) ||
        (seller.email && seller.email.toLowerCase().includes(query)) ||
        (seller.unique_id && seller.unique_id.toLowerCase().includes(query))
      );
    });
  }
  renderTable();
});

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
    chrome.storage.local.remove(['sellerData', 'currentSellerIndex', 'categoryName', 'breadcrumbSteps', 'totalSellers'], () => {
      console.log('All data cleared');
      loadData();
    });
  }
});

// Load data from chrome.storage
function loadData() {
  chrome.storage.local.get(['sellerData', 'categoryName', 'breadcrumbSteps', 'totalSellers'], (result) => {
    allData = result.sellerData || [];
    filteredData = allData;
    categoryName = result.categoryName || '';
    totalSellers = result.totalSellers || 0;
    const breadcrumbSteps = result.breadcrumbSteps || [];
    renderCategoryInfo(categoryName, breadcrumbSteps);
    renderTable();
    updateStats();
  });
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

// Remove a seller by unique_id
function removeSeller(uniqueId) {
  allData = allData.filter(s => s.unique_id !== uniqueId);
  filteredData = filteredData.filter(s => s.unique_id !== uniqueId);
  chrome.storage.local.set({ sellerData: allData }, () => {
    renderTable();
    updateStats();
  });
}

// Render table
function renderTable() {
  const tableBody = document.getElementById('tableBody');
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
    const hasEmail = seller.email && !seller.email.includes('Not found');
    const statusBadge = hasEmail
      ? '<span class="badge badge-success">✓ Found</span>'
      : '<span class="badge badge-danger">✗ Not Found</span>';

    return `
      <tr>
        <td>${seller.id || index + 1}</td>
        <td><code>${seller.unique_id || 'N/A'}</code></td>
        <td class="cell-long">${seller.business_name || 'N/A'}</td>
        <td class="cell-long">${seller.email || 'N/A'}</td>
        <td class="cell-long">${seller.headquarters || 'N/A'}</td>
        <td>
          ${seller.store_link && !seller.store_link.includes('Not found')
            ? `<a href="${seller.store_link}" target="_blank" class="link">View Store</a>`
            : 'N/A'}
        </td>
        <td>${statusBadge}</td>
        <td><button class="btn-remove" onclick="removeSeller('${seller.unique_id}')">✕</button></td>
      </tr>
    `;
  }).join('');
}

// Update statistics
function updateStats() {
  const emailCount = allData.filter(s => s.email && !s.email.includes('Not found')).length;

  document.getElementById('totalCount').textContent = totalSellers || allData.length;
  document.getElementById('emailCount').textContent = emailCount;
}

// Convert to CSV
function convertToCSV(data) {
  if (data.length === 0) return '';

  const headers = ['ID', 'Seller ID', 'Business Name', 'Email', 'Headquarters', 'Store Link'];
  const rows = data.map(seller => [
    seller.id || '',
    seller.unique_id || '',
    seller.business_name || '',
    seller.email || '',
    seller.headquarters || '',
    seller.store_link || ''
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
