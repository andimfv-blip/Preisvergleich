// Cloudflare Worker: Fega & Schmitt Shop Proxy
// Handles login, search, and HTML parsing for the Preisvergleich PWA

const FEGA_BASE = 'https://shop.fega.de/scripts';
const LOGIN_URL = `${FEGA_BASE}/clsAIShop.php?cmd=MemberLogin`;
const SEARCH_URL = `${FEGA_BASE}/shop.php`;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// Login to Fega shop and return session cookie
async function loginToFega(username, password) {
  const formData = new URLSearchParams();
  formData.append('memb_login', username);
  formData.append('memb_pass', password);

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
    redirect: 'manual',
  });

  // Extract Set-Cookie header(s)
  const cookies = response.headers.getAll('set-cookie');
  if (!cookies || cookies.length === 0) {
    // Some servers return cookie even on 200
    const singleCookie = response.headers.get('set-cookie');
    if (singleCookie) {
      return extractCookieString(singleCookie);
    }
    throw new Error('Login fehlgeschlagen: Keine Session erhalten');
  }

  return extractCookieString(cookies.join('; '));
}

// Extract cookie name=value pairs from Set-Cookie headers
function extractCookieString(setCookieHeader) {
  const cookieParts = [];
  const cookies = setCookieHeader.split(/,(?=\s*\w+=)/);

  for (const cookie of cookies) {
    const match = cookie.trim().match(/^([^=]+)=([^;]*)/);
    if (match) {
      cookieParts.push(`${match[1].trim()}=${match[2].trim()}`);
    }
  }

  return cookieParts.join('; ');
}

// Search for product by EAN
async function searchFega(ean, sessionCookie) {
  const url = `${SEARCH_URL}?cmd=Suche&q=${encodeURIComponent(ean)}`;

  const response = await fetch(url, {
    headers: {
      'Cookie': sessionCookie,
    },
  });

  if (!response.ok) {
    throw new Error(`Suche fehlgeschlagen: HTTP ${response.status}`);
  }

  return await response.text();
}

// Parse product data from Fega HTML response
// Real format of data-addtobasket:
//   "054678|MC_1_215555422|||||0.1800|0||kzrume:0,verf_zl:4000,preis-vk:18"
// Fields are pipe-separated, key-value metadata is comma-separated in the last field.
function parseProductFromHTML(html, ean) {
  const products = [];

  const addToBasketRegex = /data-addtobasket="([^"]+)"/g;
  let match;

  while ((match = addToBasketRegex.exec(html)) !== null) {
    const data = match[1];
    const pipeFields = data.split('|');

    const articleNumber = pipeFields[0] || null;

    // The last non-empty pipe field contains comma-separated key:value pairs
    // e.g. "kzrume:0,verf_zl:4000,preis-vk:18"
    const kvString = pipeFields[pipeFields.length - 1] || '';
    const kvPairs = {};
    for (const part of kvString.split(',')) {
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        kvPairs[part.substring(0, colonIdx)] = part.substring(colonIdx + 1);
      }
    }

    // Extract price
    let price = null;
    if (kvPairs['preis-vk']) {
      price = parseFloat(kvPairs['preis-vk'].replace(',', '.'));
      if (isNaN(price)) price = null;
    }

    // Extract availability from verf_zl (Zulauf) and verf_lg (Lager)
    const verfZl = parseInt(kvPairs['verf_zl'] || '0');
    const verfLg = parseInt(kvPairs['verf_lg'] || '0');
    const available = verfZl > 0 || verfLg > 0;

    products.push({ articleNumber, price, available });
  }

  // Extract product name from <p class="bold nomargin"> or <div class="art-name bold">
  let productName = null;
  const namePatterns = [
    /<p[^>]*class="bold nomargin"[^>]*>([\s\S]*?)<\/p>/i,
    /<div[^>]*class="art-name[^"]*bold[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="art-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of namePatterns) {
    const nameMatch = html.match(pattern);
    if (nameMatch) {
      productName = nameMatch[1].replace(/<[^>]+>/g, '').trim();
      if (productName) break;
    }
  }

  if (products.length === 0) {
    return null;
  }

  // Return first product (most relevant for EAN search)
  const product = products[0];
  return {
    productName: productName || 'Artikel ' + (product.articleNumber || ean),
    manufacturer: null,
    articleNumber: product.articleNumber,
    price: product.price,
    available: product.available,
    deliveryDays: null,
  };
}

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return jsonResponse({ status: 'ok', service: 'fega-proxy' });
    }

    // Search endpoint
    if (url.pathname === '/search') {
      const ean = url.searchParams.get('ean');
      const supplier = url.searchParams.get('supplier');
      const username = url.searchParams.get('username');
      const password = url.searchParams.get('password');

      if (!ean) {
        return errorResponse('Parameter "ean" fehlt');
      }
      if (supplier && supplier !== 'fega') {
        return errorResponse('Nur supplier=fega wird unterstuetzt');
      }
      if (!username || !password) {
        return errorResponse('Parameter "username" und "password" fehlen');
      }

      try {
        // Step 1: Login
        const sessionCookie = await loginToFega(username, password);

        // Step 2: Search
        const html = await searchFega(ean, sessionCookie);

        // Step 3: Parse
        const product = parseProductFromHTML(html, ean);

        if (!product) {
          return jsonResponse({
            productName: null,
            manufacturer: null,
            articleNumber: null,
            price: null,
            available: false,
            deliveryDays: null,
          });
        }

        return jsonResponse(product);
      } catch (error) {
        console.error('Fega proxy error:', error);
        return errorResponse('Fehler: ' + error.message, 502);
      }
    }

    return errorResponse('Unbekannter Pfad. Verwende GET /search?ean=...&username=...&password=...', 404);
  },
};
