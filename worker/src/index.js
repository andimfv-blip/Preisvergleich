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
function parseProductFromHTML(html, ean) {
  const products = [];

  // Match all data-addtobasket attributes
  // Format: "artikelnummer|...|preis-vk:XX|...|verf_zl:XXXX|..."
  const addToBasketRegex = /data-addtobasket="([^"]+)"/g;
  let match;

  while ((match = addToBasketRegex.exec(html)) !== null) {
    const data = match[1];
    const fields = data.split('|');

    const articleNumber = fields[0] || null;

    // Extract preis-vk
    let price = null;
    const priceField = fields.find(f => f.startsWith('preis-vk:'));
    if (priceField) {
      const priceStr = priceField.split(':')[1];
      price = parseFloat(priceStr.replace(',', '.'));
      if (isNaN(price)) price = null;
    }

    // Extract verf_zl (Verfuegbarkeit/Zulauf)
    let available = false;
    const verfField = fields.find(f => f.startsWith('verf_zl:'));
    if (verfField) {
      const verfValue = verfField.split(':')[1];
      // verf_zl > 0 means stock available
      available = parseInt(verfValue) > 0;
    }

    // Also check verf_lg (Lagerbestand)
    const verfLgField = fields.find(f => f.startsWith('verf_lg:'));
    if (verfLgField) {
      const verfLgValue = verfLgField.split(':')[1];
      if (parseInt(verfLgValue) > 0) {
        available = true;
      }
    }

    products.push({ articleNumber, price, available });
  }

  // Try to find product name from HTML near the matched product
  let productName = null;

  // Look for product description - common patterns in shop HTML
  // Try <div class="artbez"> or similar
  const namePatterns = [
    /<div[^>]*class="[^"]*artbez[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class="[^"]*artbez[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<td[^>]*class="[^"]*artbez[^"]*"[^>]*>([\s\S]*?)<\/td>/i,
    /<div[^>]*class="[^"]*bezeichnung[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<h[1-6][^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/i,
  ];

  for (const pattern of namePatterns) {
    const nameMatch = html.match(pattern);
    if (nameMatch) {
      productName = nameMatch[1].replace(/<[^>]+>/g, '').trim();
      if (productName) break;
    }
  }

  // Fallback: try to find text near the EAN or article number
  if (!productName && products.length > 0) {
    const artNr = products[0].articleNumber;
    if (artNr) {
      // Look for text near the article number
      const nearArtRegex = new RegExp(
        `(?:<[^>]*>\\s*)?${artNr}[^<]*<[^>]*>\\s*([^<]+)`,
        'i'
      );
      const nearMatch = html.match(nearArtRegex);
      if (nearMatch) {
        productName = nearMatch[1].trim();
      }
    }
  }

  if (products.length === 0) {
    return null;
  }

  // Return first product found (most relevant for EAN search)
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
