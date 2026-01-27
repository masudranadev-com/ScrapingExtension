let allData = [];
let filteredData = [];

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
  downloadFile(JSON.stringify(allData, null, 2), 'seller-data.json', 'application/json');
});

// Download CSV
document.getElementById('downloadCSV').addEventListener('click', () => {
  const csv = convertToCSV(allData);
  downloadFile(csv, 'seller-data.csv', 'text/csv');
});

// Clear data
document.getElementById('clearData').addEventListener('click', () => {
  if (confirm('Are you sure you want to delete ALL seller data? This cannot be undone!')) {
    chrome.storage.local.remove(['sellerData', 'currentSellerIndex', 'previousSellerId'], () => {
      console.log('All data cleared');
      loadData();
    });
  }
});

// Load data from chrome.storage
function loadData() {
  chrome.storage.local.get(['sellerData'], (result) => {
    allData = result.sellerData || [];
    filteredData = allData;
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
      </tr>
    `;
  }).join('');
}

// Update statistics
function updateStats() {
  const totalCount = allData.length;
  const emailCount = allData.filter(s => s.email && !s.email.includes('Not found')).length;

  document.getElementById('totalCount').textContent = totalCount;
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
