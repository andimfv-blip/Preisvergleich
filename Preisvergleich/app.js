// ========================================
// App State & Configuration
// ========================================

const APP_STATE = {
    currentTab: 'scanner',
    cart: [],
    settings: {
        fega: { url: '', username: '', password: '' },
        gautzsch: { url: '', username: '', password: '' }
    },
    scanner: null,
    currentComparison: null
};

// Load settings and cart from localStorage
function loadAppData() {
    const savedSettings = localStorage.getItem('settings');
    if (savedSettings) {
        APP_STATE.settings = JSON.parse(savedSettings);
        applySettings();
    }
    
    const savedCart = localStorage.getItem('cart');
    if (savedCart) {
        APP_STATE.cart = JSON.parse(savedCart);
        updateCartDisplay();
    }
}

function saveAppData() {
    localStorage.setItem('settings', JSON.stringify(APP_STATE.settings));
    localStorage.setItem('cart', JSON.stringify(APP_STATE.cart));
}

// ========================================
// Tab Navigation
// ========================================

function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    
    // Update panes
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === `${tabName}-tab`);
    });
    
    APP_STATE.currentTab = tabName;
    
    // Initialize scanner when switching to scanner tab
    if (tabName === 'scanner' && !APP_STATE.scanner) {
        initScanner();
    }
}

// ========================================
// Barcode Scanner
// ========================================

function initScanner() {
    const reader = document.getElementById('reader');
    
    // Check if scanner already initialized
    if (APP_STATE.scanner) return;
    
    try {
        APP_STATE.scanner = new Html5Qrcode('reader');
        
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.777778
        };
        
        APP_STATE.scanner.start(
            { facingMode: "environment" },
            config,
            onScanSuccess,
            onScanError
        ).catch(err => {
            console.error('Scanner start failed:', err);
            showToast('Kamera konnte nicht gestartet werden. Verwenden Sie die manuelle Eingabe.', 'error');
        });
    } catch (err) {
        console.error('Scanner init failed:', err);
    }
}

function onScanSuccess(decodedText, decodedResult) {
    // Vibrate if available
    if (navigator.vibrate) {
        navigator.vibrate(200);
    }
    
    // Search for the scanned code
    searchByEAN(decodedText);
}

function onScanError(error) {
    // Ignore scanning errors (they're frequent)
}

// ========================================
// Product Search & Price Comparison
// ========================================

async function searchByEAN(ean) {
    if (!ean || ean.trim() === '') {
        showToast('Bitte EAN-Code eingeben', 'error');
        return;
    }
    
    // Show loading
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('error-message').classList.add('hidden');
    document.getElementById('comparison-result').classList.add('hidden');
    
    try {
        // Fetch from both suppliers in parallel
        const [fegaResult, gautzschResult] = await Promise.all([
            fetchFromSupplier(ean, 'fega'),
            fetchFromSupplier(ean, 'gautzsch')
        ]);
        
        // Create comparison
        const comparison = {
            ean: ean,
            productName: fegaResult.productName || gautzschResult.productName || 'Unbekanntes Produkt',
            manufacturer: fegaResult.manufacturer || gautzschResult.manufacturer || null,
            fega: fegaResult,
            gautzsch: gautzschResult
        };
        
        // Determine cheapest
        if (fegaResult.price && gautzschResult.price) {
            comparison.cheapest = fegaResult.price <= gautzschResult.price ? 'fega' : 'gautzsch';
            comparison.savings = Math.abs(fegaResult.price - gautzschResult.price);
        } else if (fegaResult.price) {
            comparison.cheapest = 'fega';
        } else if (gautzschResult.price) {
            comparison.cheapest = 'gautzsch';
        }
        
        APP_STATE.currentComparison = comparison;
        displayComparison(comparison);
        
    } catch (error) {
        showError('Fehler beim Abrufen der Preise: ' + error.message);
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
}

async function fetchFromSupplier(ean, supplier) {
    const config = APP_STATE.settings[supplier];
    
    if (!config.url || !config.username || !config.password) {
        return {
            productName: null,
            manufacturer: null,
            price: null,
            available: false,
            deliveryDays: null,
            articleNumber: null
        };
    }
    
    const xmlRequest = `<?xml version="1.0" encoding="UTF-8"?>
<IDS version="1.0">
    <REQUEST>
        <ARTICLE_SEARCH>
            <EAN>${ean}</EAN>
        </ARTICLE_SEARCH>
    </REQUEST>
</IDS>`;
    
    try {
        const response = await fetch(config.url + '/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml',
                'Accept': 'application/xml',
                'Authorization': 'Basic ' + btoa(config.username + ':' + config.password)
            },
            body: xmlRequest
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const xmlText = await response.text();
        return parseXMLResponse(xmlText);
        
    } catch (error) {
        console.error(`Error fetching from ${supplier}:`, error);
        return {
            productName: null,
            manufacturer: null,
            price: null,
            available: false,
            deliveryDays: null,
            articleNumber: null
        };
    }
}

function parseXMLResponse(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    
    const getTagValue = (tagName) => {
        const element = xmlDoc.querySelector(tagName);
        return element ? element.textContent : null;
    };
    
    const priceText = getTagValue('NET_PRICE') || getTagValue('PRICE');
    const price = priceText ? parseFloat(priceText.replace(',', '.')) : null;
    
    const availableText = getTagValue('AVAILABLE');
    const available = availableText ? (availableText.toLowerCase() === 'true' || availableText === '1') : false;
    
    const deliveryText = getTagValue('DELIVERY_TIME');
    const deliveryDays = deliveryText ? parseInt(deliveryText) : null;
    
    return {
        productName: getTagValue('DESCRIPTION'),
        manufacturer: getTagValue('MANUFACTURER'),
        articleNumber: getTagValue('ARTICLE_NUMBER'),
        price: price,
        available: available,
        deliveryDays: deliveryDays
    };
}

function displayComparison(comparison) {
    const container = document.getElementById('comparison-result');
    
    let html = `
        <div class="product-info">
            <h3>${escapeHtml(comparison.productName)}</h3>
            <p>EAN: ${comparison.ean}</p>
            ${comparison.manufacturer ? `<p>Hersteller: ${escapeHtml(comparison.manufacturer)}</p>` : ''}
        </div>
        
        <div class="price-cards">
            ${renderPriceCard('fega', 'Fega & Schmitt', comparison.fega, comparison.cheapest === 'fega')}
            ${renderPriceCard('gautzsch', 'Gautzsch', comparison.gautzsch, comparison.cheapest === 'gautzsch')}
        </div>
        
        <div class="quantity-selector">
            <label>Menge:</label>
            <div class="quantity-controls">
                <button class="quantity-btn" onclick="changeQuantity(-1)">−</button>
                <span class="quantity-value" id="quantity-value">1</span>
                <button class="quantity-btn" onclick="changeQuantity(1)">+</button>
            </div>
        </div>
        
        <button class="btn btn-primary btn-block" onclick="addToCart()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="9" cy="21" r="1"/>
                <circle cx="20" cy="21" r="1"/>
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="10" y1="11" x2="14" y2="11"/>
            </svg>
            Zur Bestellliste hinzufügen
        </button>
    `;
    
    container.innerHTML = html;
    container.classList.remove('hidden');
    
    // Add click handlers for price card selection
    document.querySelectorAll('.price-card').forEach(card => {
        card.addEventListener('click', function() {
            document.querySelectorAll('.price-card').forEach(c => c.classList.remove('selected'));
            this.classList.add('selected');
        });
    });
    
    // Select cheapest by default
    if (comparison.cheapest) {
        document.querySelector(`.price-card.${comparison.cheapest}`).classList.add('selected');
    } else {
        // Select first available
        const firstAvailable = comparison.fega.available ? 'fega' : 
                             comparison.gautzsch.available ? 'gautzsch' : 'fega';
        document.querySelector(`.price-card.${firstAvailable}`).classList.add('selected');
    }
}

function renderPriceCard(id, name, data, isCheapest) {
    const priceDisplay = data.price !== null ? 
        `<div class="price ${id}">${data.price.toFixed(2)} €</div>` :
        `<div class="price unavailable">Nicht verfügbar</div>`;
    
    const availabilityClass = data.available ? 'available' : 'unavailable';
    const availabilityIcon = data.available ? '✓' : '✗';
    const availabilityText = data.available ? 'Verfügbar' : 'Nicht verfügbar';
    
    return `
        <div class="price-card ${id}" data-supplier="${id}">
            <div class="price-card-header">
                <span class="supplier-name">${name}</span>
                ${isCheapest ? '<span class="cheapest-badge">⭐</span>' : ''}
            </div>
            ${priceDisplay}
            <div class="availability ${availabilityClass}">
                <span>${availabilityIcon}</span>
                <span>${availabilityText}</span>
            </div>
            ${data.deliveryDays !== null ? `<div class="delivery-time">Lieferzeit: ${data.deliveryDays} Tage</div>` : ''}
        </div>
    `;
}

let currentQuantity = 1;

function changeQuantity(delta) {
    currentQuantity = Math.max(1, currentQuantity + delta);
    document.getElementById('quantity-value').textContent = currentQuantity;
}

function addToCart() {
    const selectedCard = document.querySelector('.price-card.selected');
    if (!selectedCard) {
        showToast('Bitte wählen Sie einen Lieferanten', 'error');
        return;
    }
    
    const supplier = selectedCard.getAttribute('data-supplier');
    const comparison = APP_STATE.currentComparison;
    const supplierData = comparison[supplier];
    
    if (!supplierData.available || supplierData.price === null) {
        showToast('Artikel ist beim gewählten Lieferanten nicht verfügbar', 'error');
        return;
    }
    
    const item = {
        id: Date.now(),
        ean: comparison.ean,
        productName: comparison.productName,
        manufacturer: comparison.manufacturer,
        supplier: supplier,
        supplierName: supplier === 'fega' ? 'Fega & Schmitt' : 'Gautzsch',
        quantity: currentQuantity,
        pricePerUnit: supplierData.price,
        totalPrice: supplierData.price * currentQuantity,
        addedDate: new Date().toISOString()
    };
    
    APP_STATE.cart.push(item);
    saveAppData();
    updateCartDisplay();
    
    showToast(`${currentQuantity}x ${comparison.productName} hinzugefügt`, 'success');
    
    // Reset quantity
    currentQuantity = 1;
    if (document.getElementById('quantity-value')) {
        document.getElementById('quantity-value').textContent = '1';
    }
}

function showError(message) {
    const errorElement = document.getElementById('error-message');
    errorElement.textContent = message;
    errorElement.classList.remove('hidden');
}

// ========================================
// Cart Management
// ========================================

function updateCartDisplay() {
    const cartItems = document.getElementById('cart-items');
    const cartSummary = document.getElementById('cart-summary');
    const cartBadge = document.getElementById('cart-badge');
    const groupBySupplier = document.getElementById('group-by-supplier').checked;
    
    // Update badge
    cartBadge.textContent = APP_STATE.cart.length;
    
    if (APP_STATE.cart.length === 0) {
        cartItems.innerHTML = `
            <div class="empty-cart">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <circle cx="9" cy="21" r="1"/>
                    <circle cx="20" cy="21" r="1"/>
                    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                </svg>
                <h3>Bestellliste ist leer</h3>
                <p>Scannen Sie Artikel, um sie zur Liste hinzuzufügen</p>
            </div>
        `;
        cartSummary.classList.add('hidden');
        return;
    }
    
    let html = '';
    
    if (groupBySupplier) {
        // Group by supplier
        const fegaItems = APP_STATE.cart.filter(item => item.supplier === 'fega');
        const gautzschItems = APP_STATE.cart.filter(item => item.supplier === 'gautzsch');
        
        if (fegaItems.length > 0) {
            html += renderCartGroup('Fega & Schmitt', fegaItems, 'fega');
        }
        if (gautzschItems.length > 0) {
            html += renderCartGroup('Gautzsch', gautzschItems, 'gautzsch');
        }
    } else {
        // Show all items
        APP_STATE.cart.forEach(item => {
            html += renderCartItem(item);
        });
    }
    
    cartItems.innerHTML = html;
    
    // Update summary
    updateCartSummary();
    cartSummary.classList.remove('hidden');
}

function renderCartGroup(name, items, supplier) {
    const total = items.reduce((sum, item) => sum + item.totalPrice, 0);
    
    let html = `
        <div class="cart-group">
            <div class="cart-group-header">
                <h3>${name}</h3>
                <span class="cart-group-total">${total.toFixed(2)} €</span>
            </div>
    `;
    
    items.forEach(item => {
        html += renderCartItem(item);
    });
    
    html += '</div>';
    return html;
}

function renderCartItem(item) {
    return `
        <div class="cart-item">
            <div class="cart-item-info">
                <div class="cart-item-name">${escapeHtml(item.productName)}</div>
                <div class="cart-item-details">
                    ${item.manufacturer ? escapeHtml(item.manufacturer) + ' • ' : ''}
                    EAN: ${item.ean} • ${item.supplierName}
                </div>
            </div>
            <div class="cart-item-price">
                <div class="cart-item-quantity">${item.quantity}x</div>
                <div class="cart-item-unit-price">${item.pricePerUnit.toFixed(2)} €</div>
                <div class="cart-item-total">${item.totalPrice.toFixed(2)} €</div>
            </div>
            <div class="cart-item-actions">
                <button class="delete-btn" onclick="removeFromCart(${item.id})">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
}

function updateCartSummary() {
    const cartSummary = document.getElementById('cart-summary');
    
    const fegaTotal = APP_STATE.cart
        .filter(item => item.supplier === 'fega')
        .reduce((sum, item) => sum + item.totalPrice, 0);
    
    const gautzschTotal = APP_STATE.cart
        .filter(item => item.supplier === 'gautzsch')
        .reduce((sum, item) => sum + item.totalPrice, 0);
    
    const grandTotal = fegaTotal + gautzschTotal;
    
    let html = '';
    
    if (fegaTotal > 0) {
        html += `
            <div class="summary-row">
                <span>Fega & Schmitt</span>
                <span>${fegaTotal.toFixed(2)} €</span>
            </div>
        `;
    }
    
    if (gautzschTotal > 0) {
        html += `
            <div class="summary-row">
                <span>Gautzsch</span>
                <span>${gautzschTotal.toFixed(2)} €</span>
            </div>
        `;
    }
    
    html += `
        <div class="summary-row total">
            <span>Gesamtsumme</span>
            <span>${grandTotal.toFixed(2)} €</span>
        </div>
    `;
    
    cartSummary.innerHTML = html;
}

function removeFromCart(itemId) {
    APP_STATE.cart = APP_STATE.cart.filter(item => item.id !== itemId);
    saveAppData();
    updateCartDisplay();
    showToast('Artikel entfernt', 'success');
}

function clearCart() {
    if (confirm('Möchten Sie wirklich alle Artikel aus der Bestellliste entfernen?')) {
        APP_STATE.cart = [];
        saveAppData();
        updateCartDisplay();
        showToast('Bestellliste geleert', 'success');
    }
}

// ========================================
// Export Functions
// ========================================

function exportToCSV() {
    let csv = 'Lieferant,EAN,Artikelname,Hersteller,Menge,Einzelpreis,Gesamtpreis\n';
    
    APP_STATE.cart.forEach(item => {
        csv += [
            item.supplierName,
            item.ean,
            `"${item.productName.replace(/"/g, '""')}"`,
            `"${(item.manufacturer || '').replace(/"/g, '""')}"`,
            item.quantity,
            item.pricePerUnit.toFixed(2),
            item.totalPrice.toFixed(2)
        ].join(',') + '\n';
    });
    
    // Add totals
    const fegaTotal = APP_STATE.cart.filter(i => i.supplier === 'fega').reduce((s, i) => s + i.totalPrice, 0);
    const gautzschTotal = APP_STATE.cart.filter(i => i.supplier === 'gautzsch').reduce((s, i) => s + i.totalPrice, 0);
    
    csv += '\n';
    if (fegaTotal > 0) csv += `Fega & Schmitt Gesamt:,,,,,${fegaTotal.toFixed(2)}\n`;
    if (gautzschTotal > 0) csv += `Gautzsch Gesamt:,,,,,${gautzschTotal.toFixed(2)}\n`;
    csv += `Gesamtsumme:,,,,,${(fegaTotal + gautzschTotal).toFixed(2)}\n`;
    
    downloadFile(csv, 'bestellliste.csv', 'text/csv');
    showToast('CSV exportiert', 'success');
}

function exportToPDF() {
    let text = 'BESTELLLISTE\n';
    text += `Erstellt am: ${new Date().toLocaleString('de-DE')}\n\n`;
    
    ['fega', 'gautzsch'].forEach(supplier => {
        const items = APP_STATE.cart.filter(i => i.supplier === supplier);
        if (items.length > 0) {
            const name = supplier === 'fega' ? 'Fega & Schmitt' : 'Gautzsch';
            text += `\n--- ${name} ---\n\n`;
            
            items.forEach(item => {
                text += `${item.productName}\n`;
                text += `EAN: ${item.ean}\n`;
                if (item.manufacturer) text += `Hersteller: ${item.manufacturer}\n`;
                text += `Menge: ${item.quantity}x à ${item.pricePerUnit.toFixed(2)} €\n`;
                text += `Summe: ${item.totalPrice.toFixed(2)} €\n\n`;
            });
            
            const total = items.reduce((s, i) => s + i.totalPrice, 0);
            text += `Zwischensumme ${name}: ${total.toFixed(2)} €\n`;
        }
    });
    
    const grandTotal = APP_STATE.cart.reduce((s, i) => s + i.totalPrice, 0);
    text += '\n==================\n';
    text += `GESAMTSUMME: ${grandTotal.toFixed(2)} €\n`;
    
    downloadFile(text, 'bestellliste.txt', 'text/plain');
    showToast('PDF (Text) exportiert', 'success');
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ========================================
// Settings
// ========================================

function initSettings() {
    const form = document.getElementById('settings-form');
    
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        saveSettings();
    });
}

function applySettings() {
    document.getElementById('fega-url').value = APP_STATE.settings.fega.url;
    document.getElementById('fega-username').value = APP_STATE.settings.fega.username;
    document.getElementById('fega-password').value = APP_STATE.settings.fega.password;
    
    document.getElementById('gautzsch-url').value = APP_STATE.settings.gautzsch.url;
    document.getElementById('gautzsch-username').value = APP_STATE.settings.gautzsch.username;
    document.getElementById('gautzsch-password').value = APP_STATE.settings.gautzsch.password;
}

function saveSettings() {
    APP_STATE.settings.fega = {
        url: document.getElementById('fega-url').value.trim(),
        username: document.getElementById('fega-username').value.trim(),
        password: document.getElementById('fega-password').value
    };
    
    APP_STATE.settings.gautzsch = {
        url: document.getElementById('gautzsch-url').value.trim(),
        username: document.getElementById('gautzsch-username').value.trim(),
        password: document.getElementById('gautzsch-password').value
    };
    
    saveAppData();
    
    const message = document.getElementById('settings-message');
    message.textContent = 'Einstellungen gespeichert';
    message.className = 'settings-message success';
    message.classList.remove('hidden');
    
    setTimeout(() => {
        message.classList.add('hidden');
    }, 3000);
}

function clearCache() {
    if (confirm('Möchten Sie wirklich alle Daten löschen? Dies kann nicht rückgängig gemacht werden.')) {
        localStorage.clear();
        APP_STATE.cart = [];
        APP_STATE.settings = {
            fega: { url: '', username: '', password: '' },
            gautzsch: { url: '', username: '', password: '' }
        };
        applySettings();
        updateCartDisplay();
        showToast('Cache geleert', 'success');
    }
}

// ========================================
// Utilities
// ========================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s';
        setTimeout(() => {
            container.removeChild(toast);
        }, 300);
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========================================
// Event Listeners
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    // Load app data
    loadAppData();
    
    // Initialize components
    initTabs();
    initSettings();
    
    // Manual search
    document.getElementById('search-btn').addEventListener('click', () => {
        const ean = document.getElementById('manual-ean').value.trim();
        searchByEAN(ean);
    });
    
    document.getElementById('manual-ean').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const ean = e.target.value.trim();
            searchByEAN(ean);
        }
    });
    
    // Cart controls
    document.getElementById('group-by-supplier').addEventListener('change', updateCartDisplay);
    document.getElementById('clear-cart-btn').addEventListener('click', clearCart);
    document.getElementById('export-csv-btn').addEventListener('click', exportToCSV);
    document.getElementById('export-pdf-btn').addEventListener('click', exportToPDF);
    document.getElementById('clear-cache-btn').addEventListener('click', clearCache);
    
    // Online/Offline status
    function updateOnlineStatus() {
        const statusEl = document.getElementById('online-status');
        statusEl.textContent = navigator.onLine ? 'Online' : 'Offline';
        statusEl.style.color = navigator.onLine ? 'var(--color-success)' : 'var(--color-danger)';
    }
    
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
    
    // Initialize scanner on first tab switch
    if (APP_STATE.currentTab === 'scanner') {
        initScanner();
    }
});

// ========================================
// Service Worker Registration (PWA)
// ========================================

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service Worker registered'))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}
