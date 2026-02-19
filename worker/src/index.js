// Cloudflare Worker: Supplier Shop Proxy (Fega & Gautzsch)
// Handles login, search, and HTML parsing for the Preisvergleich PWA

const FEGA_BASE = 'https://shop.fega.de/scripts';
const LOGIN_URL = `${FEGA_BASE}/clsAIShop.php?cmd=MemberLogin`;
const SEARCH_URL = `${FEGA_BASE}/shop.php`;

const GAUTZSCH_BASE = 'https://www.onlinesystem.de';
const GAUTZSCH_LOGIN_URL = `${GAUTZSCH_BASE}/Default.aspx`;
const GAUTZSCH_V5_BASE = 'https://v5.onlinesystem.de';
const GAUTZSCH_V5_LOGIN_URL = `${GAUTZSCH_V5_BASE}/MigrationLogin`;

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

// ========================================
// Fega & Schmitt
// ========================================

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
function parseFegaProductFromHTML(html, ean) {
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

// ========================================
// Gautzsch (ASP.NET WebForms)
// ========================================

// Extract ASP.NET hidden fields (__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION, etc.)
function extractAspNetFields(html) {
  const fields = {};
  const fieldNames = [
    '__VIEWSTATE',
    '__VIEWSTATEGENERATOR',
    '__EVENTVALIDATION',
    '__EVENTTARGET',
    '__EVENTARGUMENT',
    '__LASTFOCUS',
  ];

  for (const name of fieldNames) {
    const regex = new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i');
    const match = html.match(regex);
    if (match) {
      fields[name] = match[1];
    }
  }

  return fields;
}

// Extract all hidden input fields from HTML (not just the known ASP.NET ones)
function extractAllHiddenFields(html) {
  const fields = {};
  const regex = /<input[^>]*type="hidden"[^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/name="([^"]*)"/i);
    const valueMatch = tag.match(/value="([^"]*)"/i);
    if (nameMatch) {
      fields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }

  return fields;
}

// Extract cookies from a fetch response, merging with existing cookies
function extractResponseCookies(response, existingCookies) {
  const cookieMap = {};

  // Parse existing cookies into map
  if (existingCookies) {
    for (const pair of existingCookies.split('; ')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        cookieMap[pair.substring(0, eqIdx).trim()] = pair.substring(eqIdx + 1).trim();
      }
    }
  }

  // Extract from Set-Cookie headers - each header is one cookie
  const setCookieHeaders = response.headers.getAll('set-cookie');
  for (const header of setCookieHeaders) {
    // Each Set-Cookie header: "name=value; path=/; HttpOnly; ..."
    // We only need the name=value part (before the first semicolon)
    const semicolonIdx = header.indexOf(';');
    const nameValue = semicolonIdx > 0 ? header.substring(0, semicolonIdx) : header;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) {
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      // Skip empty auth cookies (like .ASPXAUTH=; which means "clear this cookie")
      if (value || name === '.ASPXAUTH') {
        cookieMap[name] = value;
      }
    }
  }

  // Also try single header fallback
  if (setCookieHeaders.length === 0) {
    const singleCookie = response.headers.get('set-cookie');
    if (singleCookie) {
      const semicolonIdx = singleCookie.indexOf(';');
      const nameValue = semicolonIdx > 0 ? singleCookie.substring(0, semicolonIdx) : singleCookie;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        cookieMap[nameValue.substring(0, eqIdx).trim()] = nameValue.substring(eqIdx + 1).trim();
      }
    }
  }

  return Object.entries(cookieMap)
    .filter(([, v]) => v) // skip empty values
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Login to Gautzsch v5.onlinesystem.de and return session cookies
// Flow: GET /Login for CSRF token → POST /Login with credentials → session cookie
async function loginToGautzsch(username, password) {
  const loginPageUrl = `${GAUTZSCH_V5_BASE}/Login`;

  // Step 1: GET the v5 login page to obtain session cookie + CSRF token
  const getResponse = await fetch(loginPageUrl, {
    headers: { 'User-Agent': BROWSER_UA },
    redirect: 'follow',
  });

  let cookies = extractResponseCookies(getResponse, '');
  const loginHtml = await getResponse.text();

  // Extract ASP.NET Core anti-forgery token
  // Format: <input name="__RequestVerificationToken" type="hidden" value="..." />
  const csrfMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i) ||
                    loginHtml.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  // Also check for token in meta tag (some ASP.NET Core apps use this)
  const metaCsrf = loginHtml.match(/<meta[^>]*name="RequestVerificationToken"[^>]*content="([^"]+)"/i);
  const finalCsrfToken = csrfToken || (metaCsrf ? metaCsrf[1] : '');

  // Step 2: POST login form
  const formData = new URLSearchParams();
  formData.set('Username', username);
  formData.set('Password', password);
  formData.set('RememberMe', 'false');
  if (finalCsrfToken) {
    formData.set('__RequestVerificationToken', finalCsrfToken);
  }

  const postResponse = await fetch(loginPageUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      'Referer': loginPageUrl,
      'Origin': GAUTZSCH_V5_BASE,
      'Cookie': cookies,
    },
    body: formData.toString(),
    redirect: 'manual',
  });

  cookies = extractResponseCookies(postResponse, cookies);

  // Follow redirects after login (success = redirect to home)
  let location = postResponse.headers.get('location');
  let followed = 0;
  while (location && followed < 5) {
    const redirectUrl = location.startsWith('http') ? location : `${GAUTZSCH_V5_BASE}${location}`;
    const followResponse = await fetch(redirectUrl, {
      headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookies },
      redirect: 'manual',
    });
    cookies = extractResponseCookies(followResponse, cookies);
    location = followResponse.headers.get('location');
    followed++;
  }

  // Check login success: POST to login page should redirect (302) on success,
  // or return 200 with errors on failure
  if (postResponse.status === 200 && !postResponse.headers.get('location')) {
    throw new Error('Gautzsch v5: Login fehlgeschlagen (falsche Credentials oder CSRF-Token)');
  }

  if (!cookies) {
    throw new Error('Gautzsch v5: Keine Session-Cookies erhalten');
  }

  return cookies;
}

// Find ASP.NET PostBack target from javascript:__doPostBack('target','')
function findPostBackTarget(html, partialId) {
  const regex = new RegExp(`__doPostBack\\('([^']*${partialId}[^']*)'`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

// Find ASP.NET field name by partial ID (e.g. "txtBenutzername" -> "ctl00$ContentPlaceHolder1$txtBenutzername")
function findFieldName(html, partialId) {
  // Match name="..." attribute where the name ends with the partial ID
  const regex = new RegExp(`name="([^"]*${partialId}[^"]*)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

// Merge two cookie strings, newer values override older
function mergeCookies(existing, newer) {
  const cookieMap = {};

  for (const str of [existing, newer]) {
    if (!str) continue;
    for (const pair of str.split('; ')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        cookieMap[pair.substring(0, eqIdx).trim()] = pair.substring(eqIdx + 1).trim();
      }
    }
  }

  return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Search for product on Gautzsch v5 by EAN/article number using the OxomiArticleSearch API
// Returns the first matching product object from the JSON response, or null if not found.
async function searchGautzsch(ean, sessionCookies) {
  const searchUrl = `${GAUTZSCH_V5_BASE}/ProductList/OxomiArticleSearch?searchTerm=${encodeURIComponent(ean)}`;
  const response = await fetch(searchUrl, {
    headers: {
      'Cookie': sessionCookies,
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Gautzsch Suche fehlgeschlagen: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    // Session expired or WAF block
    throw new Error(`Gautzsch: Unerwartete Antwort (${response.status}, ${contentType})`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) {
    return null; // Product not found in Gautzsch catalog
  }

  return results[0]; // Return first (most relevant) match
}

// Check if the page is a login page (not authenticated)
// Uses specific login form elements, not generic words (avoid false positives with "Abmelden")
function isLoginPage(html) {
  return html.includes('ContentPlaceHolder1_SideUser') ||
         html.includes('CmdLogOn') ||
         html.includes('login-container');
}

// Parse product data from Gautzsch OxomiArticleSearch JSON result
// The OxomiArticleSearch API returns product objects with price/availability already included.
function parseGautzschProduct(product, ean) {
  if (!product || typeof product !== 'object') return null;

  // Product name (productName is the full description)
  const productName = product.productName || product.productName1 || null;

  // Article number (Gautzsch's own article number)
  const articleNumber = product.productNumber || null;

  // Manufacturer name
  const manufacturer = product.manufacturerName || product.manufacturerShortName || null;

  // Net price for the customer (quantitySinglePrice is already customer-specific)
  let price = null;
  if (product.quantitySinglePrice !== undefined && product.quantitySinglePrice !== null) {
    price = parseFloat(product.quantitySinglePrice);
    if (isNaN(price) || price <= 0) price = null;
  }

  // Price unit: how many units the price applies to (e.g., 100 for "price per 100m")
  const priceUnit = product.priceUnit || 1;

  // Availability: availabelOrderQuantity contains a string like "111200 M" or a number
  let available = false;
  if (product.availabelOrderQuantity !== undefined && product.availabelOrderQuantity !== null) {
    const qtyStr = String(product.availabelOrderQuantity).replace(/[^\d.]/g, '');
    const qty = parseFloat(qtyStr);
    available = !isNaN(qty) && qty > 0;
  } else if (product.isOrderable !== undefined) {
    available = !!product.isOrderable;
  }

  if (!productName && !articleNumber && price === null) return null;

  return {
    productName: productName || ('Artikel ' + (articleNumber || ean)),
    manufacturer,
    articleNumber,
    price,
    priceUnit: priceUnit !== 1 ? priceUnit : undefined,
    priceQuantityUnit: product.priceQuantityUnit || undefined,
    available,
    deliveryDays: null,
  };
}

// ========================================
// Debug endpoint for Gautzsch reverse-engineering
// ========================================

async function handleDebugGautzsch(url) {
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  const ean = url.searchParams.get('ean');
  const step = url.searchParams.get('step') || 'login-page';

  const debug = { step, timestamps: {} };

  try {
    if (step === 'login-page') {
      // Just fetch the login page and show its structure
      debug.timestamps.start = Date.now();
      const response = await fetch(GAUTZSCH_LOGIN_URL);
      const html = await response.text();
      debug.timestamps.fetched = Date.now();

      const aspFields = extractAspNetFields(html);
      const inputFields = [];
      const inputRegex = /<input[^>]*name="([^"]*)"[^>]*>/gi;
      let match;
      while ((match = inputRegex.exec(html)) !== null) {
        inputFields.push(match[1]);
      }

      // Find buttons
      const buttons = [];
      const btnRegex = /<input[^>]*type="submit"[^>]*(?:name="([^"]*)")?[^>]*(?:value="([^"]*)")?[^>]*>/gi;
      while ((match = btnRegex.exec(html)) !== null) {
        buttons.push({ name: match[1], value: match[2] });
      }

      // Find links that might be search pages
      const links = [];
      const linkRegex = /href="([^"]*(?:such|search|artikel|article)[^"]*)"/gi;
      while ((match = linkRegex.exec(html)) !== null) {
        links.push(match[1]);
      }

      // Find all __doPostBack targets
      const postBacks = [];
      const pbRegex = /__doPostBack\('([^']*)'/g;
      let pbMatch;
      while ((pbMatch = pbRegex.exec(html)) !== null) {
        postBacks.push(pbMatch[1]);
      }

      // Find login-related HTML section
      const loginSectionMatch = html.match(/(<div[^>]*(?:login|Login|anmeld)[^>]*>[\s\S]{0,3000})/i);
      const loginSection = loginSectionMatch ? loginSectionMatch[1] : null;

      // Find all anchor tags with PostBack
      const loginAnchors = [];
      const anchorRegex = /<a[^>]*__doPostBack[^>]*>[\s\S]*?<\/a>/gi;
      let aMatch;
      while ((aMatch = anchorRegex.exec(html)) !== null) {
        if (/login|anmeld|einlog/i.test(aMatch[0])) {
          loginAnchors.push(aMatch[0]);
        }
      }

      debug.aspFields = Object.keys(aspFields);
      debug.inputFields = inputFields;
      debug.buttons = buttons;
      debug.searchLinks = links;
      debug.postBackTargets = postBacks;
      debug.loginAnchors = loginAnchors;
      debug.loginSection = loginSection;
      debug.htmlLength = html.length;
      debug.htmlSnippet = html.substring(0, 3000);
      debug.cookies = response.headers.get('set-cookie');

      // Find ALL buttons, links, and inputs that could submit the form
      const allClickables = [];
      const clickRegex = /<(?:button|a|input)[^>]*(?:onclick|submit|login|anmeld|Login)[^>]*>[\s\S]*?(?:<\/(?:button|a)>)?/gi;
      while ((match = clickRegex.exec(html)) !== null) {
        allClickables.push(match[0].substring(0, 500));
      }
      debug.loginClickables = allClickables;

      // Also get the full login form area (bigger window)
      const loginFormMatch = html.match(/login-container[\s\S]{0,5000}/i);
      debug.loginFormFull = loginFormMatch ? loginFormMatch[0].substring(0, 5000) : null;

      return jsonResponse(debug);
    }

    if (step === 'login') {
      if (!username || !password) {
        return errorResponse('username und password Parameter benoetigt');
      }

      debug.timestamps.start = Date.now();
      const cookies = await loginToGautzsch(username, password);
      debug.timestamps.loggedIn = Date.now();
      debug.cookies = cookies;

      // Fetch v5 home page after login to check if we're authenticated
      const mainResponse = await fetch(`${GAUTZSCH_V5_BASE}/`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA },
        redirect: 'follow',
      });
      const mainHtml = await mainResponse.text();
      debug.timestamps.mainPage = Date.now();

      debug.mainPageUrl = mainResponse.url;
      debug.isLoginPage = isLoginPage(mainHtml);
      debug.mainPageLength = mainHtml.length;
      debug.mainPageTitle = (mainHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim();

      // Find all links on the main page
      const links = [];
      const linkRegex = /href="([^"]+)"/gi;
      let match;
      while ((match = linkRegex.exec(mainHtml)) !== null) {
        links.push(match[1]);
      }
      debug.links = links.filter(l => !l.startsWith('#') && !l.startsWith('javascript') && l.length < 100);

      // Find input fields
      const inputFields = [];
      const inputRegex = /<input[^>]*name="([^"]*)"[^>]*>/gi;
      while ((match = inputRegex.exec(mainHtml)) !== null) {
        inputFields.push(match[1]);
      }
      debug.inputFields = inputFields;

      debug.mainPageSnippet = mainHtml.substring(0, 5000);

      return jsonResponse(debug);
    }

    if (step === 'search') {
      if (!username || !password) {
        return errorResponse('username und password Parameter benoetigt');
      }
      if (!ean) {
        return errorResponse('ean Parameter benoetigt');
      }

      debug.timestamps.start = Date.now();
      const cookies = await loginToGautzsch(username, password);
      debug.timestamps.loggedIn = Date.now();

      const result = await searchGautzsch(ean, cookies);
      debug.timestamps.searched = Date.now();

      debug.searchUrl = result.url;
      debug.htmlLength = result.html.length;
      debug.isLoginPage = isLoginPage(result.html);
      debug.htmlSnippet = result.html.substring(0, 8000);

      // Find product-specific sections in the full HTML
      const fullHtml = result.html;
      const searchTerms = ['€', 'preis', 'Preis', 'artikel', 'lager', 'verfüg', 'EAN', 'ean', 'Artikelnr'];
      debug.productHints = {};
      for (const term of searchTerms) {
        const idx = fullHtml.indexOf(term);
        if (idx >= 0) {
          debug.productHints[term] = fullHtml.substring(Math.max(0, idx - 100), idx + 300);
        }
      }

      // Find product listing area - search for price (€) and article patterns
      const euroIdx = fullHtml.indexOf(' €');
      if (euroIdx >= 0) {
        debug.priceArea = fullHtml.substring(Math.max(0, euroIdx - 500), euroIdx + 500);
      }

      // Look for data-* attributes with product info (common in modern apps)
      const dataAttrs = [...fullHtml.matchAll(/data-(?:ean|article|product|price|stock)[^=]*="([^"]+)"/gi)].map(m => m[0]);
      debug.dataAttributes = dataAttrs.slice(0, 20);

      // Look for JSON data embedded in page (ASP.NET Core often uses this)
      const jsonDataMatch = fullHtml.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]{0,5000}?});/i) ||
                            fullHtml.match(/window\.__data__\s*=\s*({[\s\S]{0,5000}?});/i) ||
                            fullHtml.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]{0,10000}?)<\/script>/i);
      debug.jsonData = jsonDataMatch ? jsonDataMatch[1].substring(0, 3000) : null;

      // Sample HTML at different positions (middle sections)
      debug.htmlAt30k = fullHtml.substring(30000, 32000);
      debug.htmlAt60k = fullHtml.substring(60000, 62000);
      debug.htmlAt100k = fullHtml.substring(100000, 102000);

      // Try parsing
      const parsed = parseGautzschHTML(result.html, ean);
      debug.parsed = parsed;

      return jsonResponse(debug);
    }

    if (step === 'post-debug') {
      // Low-level debug: show exactly what GET returns and what POST response looks like
      if (!username || !password) {
        return errorResponse('username und password Parameter benoetigt');
      }

      // GET login page
      const getResp = await fetch(GAUTZSCH_LOGIN_URL, {
        headers: { 'User-Agent': BROWSER_UA },
        redirect: 'manual',
      });
      const getHtml = await getResp.text();
      const getCookies = extractResponseCookies(getResp, '');
      const hiddenFields = extractAllHiddenFields(getHtml);

      const antiXsrfMatch = getCookies.match(/__AntiXsrfToken=([^;]+)/);
      const antiXsrfToken = antiXsrfMatch ? antiXsrfMatch[1] : '';
      if (antiXsrfToken) {
        hiddenFields['ctl00$forgeryToken'] = antiXsrfToken;
      }

      debug.getCookies = getCookies;
      debug.antiXsrfToken = antiXsrfToken;
      debug.hiddenFieldNames = Object.keys(hiddenFields);
      debug.hiddenFieldCount = Object.keys(hiddenFields).length;
      debug.hasViewState = '__VIEWSTATE' in hiddenFields;
      debug.viewStateLength = (hiddenFields['__VIEWSTATE'] || '').length;
      debug.forgeryToken = hiddenFields['ctl00$forgeryToken'] || null;

      // Build POST form data
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(hiddenFields)) {
        formData.append(key, value);
      }
      formData.set('ctl00$ContentPlaceHolder1$SideUser', username);
      formData.set('ctl00$ContentPlaceHolder1$Password', password);
      formData.set('ctl00$ContentPlaceHolder1$HiddenPassword', password);
      formData.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$CmdLogOn');
      formData.set('__EVENTARGUMENT', '');

      debug.postBodyLength = formData.toString().length;
      debug.postFieldCount = [...formData.keys()].length;

      // POST login
      const postResp = await fetch(GAUTZSCH_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BROWSER_UA,
          'Cookie': getCookies,
        },
        body: formData.toString(),
        redirect: 'manual',
      });

      debug.postStatus = postResp.status;
      debug.postLocation = postResp.headers.get('location');
      const postCookieHeaders = postResp.headers.getAll('set-cookie');
      debug.postSetCookies = postCookieHeaders;
      debug.postCookies = extractResponseCookies(postResp, getCookies);
      const postBody = await postResp.text();
      debug.postBodyLength2 = postBody.length;
      debug.postBodySnippet = postBody.substring(0, 500);

      // Check if still on login page by looking for the SideUser field
      debug.postHasSideUser = postBody.includes('ContentPlaceHolder1_SideUser');
      debug.postHasLoginContainer = postBody.includes('login-container');

      // Page title
      const titleMatch = postBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      debug.postPageTitle = titleMatch ? titleMatch[1].trim() : null;

      // Check for logged-in indicators
      const userIdJsMatch = postBody.match(/data\.user\.userId\s*=\s*'([^']+)'/);
      debug.postUserId = userIdJsMatch ? userIdJsMatch[1] : null;
      const kdNrMatch = postBody.match(/HiddenField_KdNr[^>]*value="([^"]*)"/);
      debug.postKdNr = kdNrMatch ? kdNrMatch[1] : null;

      // Show full login-container content from POST response
      const postContainer = postBody.match(/login-container[\s\S]{0,4000}/i);
      debug.postContainerRaw = postContainer ? postContainer[0].substring(0, 4000) : null;

      // Look for any redirect URLs in the POST body (all patterns)
      const allJsLocations = [...postBody.matchAll(/(?:window\.location(?:\.replace|\.href|\.assign)?|location\.replace|location\.href)\s*[=(]\s*["']([^"']+)["']/g)].map(m => m[1]);
      debug.postJsRedirects = allJsLocations;

      // Look for meta refresh
      const metaRefresh = postBody.match(/<meta[^>]*http-equiv="refresh"[^>]*content="[^"]*url=([^"]+)"/i);
      debug.postMetaRefresh = metaRefresh ? metaRefresh[1] : null;

      // Look for adv.onlinesystem.de anywhere in the page
      const advMatches = [...postBody.matchAll(/adv\.onlinesystem\.de[^"'\s<>]*/g)].map(m => m[0]);
      debug.postAdvUrls = advMatches;

      // Search for all onlinesystem.de URLs
      const allOlsUrls = [...postBody.matchAll(/https?:\/\/[a-zA-Z0-9._-]+\.onlinesystem\.de[^"'\s<>]*/g)].map(m => m[0]);
      debug.postAllOlsUrls = [...new Set(allOlsUrls)];

      // HiddenField_KdNr - customer number (non-empty = logged in)
      const kdNrMatch2 = postBody.match(/name="ctl00\$HiddenField_KdNr"[^>]*value="([^"]*)"/i) ||
                         postBody.match(/id="ctl00_HiddenField_KdNr"[^>]*value="([^"]*)"/i);
      debug.postKdNrField = kdNrMatch2 ? kdNrMatch2[1] : 'field not found';

      // Find v5.onlinesystem.de context in full body
      const v5Idx = postBody.indexOf('v5.onlinesystem.de');
      if (v5Idx >= 0) {
        debug.v5Context = postBody.substring(Math.max(0, v5Idx - 300), v5Idx + 500);
      }

      // Look for error messages (styled in red on this site)
      const errorMatches = postBody.match(/color: ?#e30613[^>]*>([^<]{1,200})/g) || [];
      debug.errorMessages = errorMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

      // Look for the login section in POST response
      const postLoginSection = postBody.match(/login-container[\s\S]{0,3000}/i);
      debug.postLoginSection = postLoginSection ? postLoginSection[0].substring(0, 3000) : null;

      // Check userId in JS (logged in = non-zero userId)
      const userIdMatch = postBody.match(/data\.user\.userId\s*=\s*'([^']+)'/);
      debug.userId = userIdMatch ? userIdMatch[1] : null;

      return jsonResponse(debug);
    }

    if (step === 'v5-login') {
      // Debug: Trace exact MigrationLogin redirect chain, then try v5 direct login
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');

      debug.redirectChain = [];
      const formData = new URLSearchParams();
      formData.set('Username', username);
      formData.set('Password', password);

      // Step 1: POST to MigrationLogin and trace each redirect manually
      let currentUrl = GAUTZSCH_V5_LOGIN_URL;
      let currentCookies = '';
      let body = formData.toString();
      let method = 'POST';
      let headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BROWSER_UA,
        'Referer': GAUTZSCH_LOGIN_URL,
        'Origin': GAUTZSCH_BASE,
      };

      for (let i = 0; i < 8; i++) {
        const resp = await fetch(currentUrl, {
          method,
          headers: { ...headers, 'Cookie': currentCookies },
          body: method === 'POST' ? body : undefined,
          redirect: 'manual',
        });

        const newCookies = extractResponseCookies(resp, currentCookies);
        currentCookies = newCookies;

        const step_info = {
          step: i,
          url: currentUrl,
          status: resp.status,
          location: resp.headers.get('location'),
          setCookies: resp.headers.getAll('set-cookie').map(c => c.split(';')[0]),
          cookies: currentCookies.substring(0, 200),
        };

        // Get a snippet of the body if no redirect
        if (resp.status !== 302 && resp.status !== 301) {
          const text = await resp.text();
          step_info.bodyLength = text.length;
          step_info.bodySnippet = text.substring(0, 1000);
          debug.redirectChain.push(step_info);
          break;
        }

        debug.redirectChain.push(step_info);

        const location = resp.headers.get('location');
        if (!location) break;

        currentUrl = location.startsWith('http') ? location : `${GAUTZSCH_V5_BASE}${location}`;
        method = 'GET';
        body = undefined;
        headers = { 'User-Agent': BROWSER_UA };
      }

      debug.finalCookies = currentCookies;
      return jsonResponse(debug);
    }

    if (step === 'v5-priceflow') {
      // Test the full price lookup flow: OxomiArticleSearch → LoadPriceData
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');
      if (!ean) return errorResponse('ean Parameter benoetigt');

      const cookies = await loginToGautzsch(username, password);

      // Step 1: Search for product via OxomiArticleSearch
      const searchTerm = ean; // could be EAN or article number
      const searchResp = await fetch(`${GAUTZSCH_V5_BASE}/ProductList/OxomiArticleSearch?searchTerm=${encodeURIComponent(searchTerm)}`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        redirect: 'follow',
      });
      const searchBody = await searchResp.text();
      let searchJson = null;
      try { searchJson = JSON.parse(searchBody); } catch (e) {}

      // Also try with generic term to see structure
      const kabelResp = await fetch(`${GAUTZSCH_V5_BASE}/ProductList/OxomiArticleSearch?searchTerm=kabel`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        redirect: 'follow',
      });
      const kabelBody = await kabelResp.text();
      let kabelJson = null;
      try { kabelJson = JSON.parse(kabelBody); } catch (e) {}

      // Get first product from kabel search
      const firstProduct = kabelJson && Array.isArray(kabelJson) ? kabelJson[0] : null;

      // Step 2: POST to LoadPriceData with first product
      let loadPriceResult = null;
      if (firstProduct) {
        const payload = {
          products: [{
            assortmentId: firstProduct.assortmentId || firstProduct.AssortmentId || null,
            dataKey: firstProduct.dataKey || firstProduct.DataKey || null,
            priceQuantityUnit: firstProduct.priceQuantityUnit || firstProduct.PriceQuantityUnit || null,
            productId: firstProduct.productId || firstProduct.ProductId || null,
            productNumber: firstProduct.productNumber || firstProduct.ProductNumber || null,
            quantity: 1,
            salesQuantityUnit: firstProduct.salesQuantityUnit || firstProduct.SalesQuantityUnit || null,
            layout: firstProduct.layout || firstProduct.Layout || null,
          }],
          idPrefix: 'debug',
          location: 'Search',
        };

        const priceResp = await fetch(`${GAUTZSCH_V5_BASE}/ProductList/LoadPriceData`, {
          method: 'POST',
          headers: {
            'Cookie': cookies,
            'User-Agent': BROWSER_UA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*',
          },
          body: JSON.stringify(payload),
          redirect: 'follow',
        });
        const priceBody = await priceResp.text();
        loadPriceResult = {
          status: priceResp.status,
          contentType: priceResp.headers.get('content-type'),
          bodyLength: priceBody.length,
          body: priceBody.substring(0, 2000),
        };
      }

      return jsonResponse({
        searchStatus: searchResp.status,
        searchLength: searchBody.length,
        searchResultCount: Array.isArray(searchJson) ? searchJson.length : 'not array',
        searchFirstItem: searchJson && Array.isArray(searchJson) ? searchJson[0] : searchJson,

        kabelStatus: kabelResp.status,
        kabelLength: kabelBody.length,
        kabelResultCount: Array.isArray(kabelJson) ? kabelJson.length : 'not array',
        kabelFirstItemKeys: firstProduct ? Object.keys(firstProduct) : null,
        kabelFirstItem: firstProduct,

        loadPricePayload: firstProduct ? {
          productId: firstProduct.productId || firstProduct.ProductId,
          productNumber: firstProduct.productNumber || firstProduct.ProductNumber,
        } : null,
        loadPriceResult,
      });
    }

    if (step === 'v5-jsflow') {
      // Examine app.min.js to understand the search/product loading flow
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');
      if (!ean) return errorResponse('ean Parameter benoetigt');

      const cookies = await loginToGautzsch(username, password);

      // Fetch app.min.js and find key patterns
      const jsResp = await fetch(`${GAUTZSCH_V5_BASE}/sec/js/app.min.js`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA },
      });
      const js = await jsResp.text();

      // Find context around loadPrices, OxomiArticleSearch, SearchResult
      const findContext = (str, keyword, chars = 300) => {
        const idx = str.indexOf(keyword);
        if (idx < 0) return null;
        return str.substring(Math.max(0, idx - chars), idx + chars + keyword.length);
      };

      // Find all unique fetch/ajax call patterns
      const fetchPatterns = [...js.matchAll(/fetch\(["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
      const axiosPatterns = [...js.matchAll(/axios\.\w+\(["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
      const urlPatterns = [...js.matchAll(/url\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]);

      // Try OxomiArticleSearch with a broader term to see if it works at all
      const oxomiGeneral = await fetch(`${GAUTZSCH_V5_BASE}/ProductList/OxomiArticleSearch?searchTerm=kabel`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        redirect: 'follow',
      });
      const oxomiGeneralBody = await oxomiGeneral.text();

      // Try search landing page variant
      const landingResp = await fetch(`${GAUTZSCH_V5_BASE}/search/LandingPage/${encodeURIComponent(ean)}`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        redirect: 'follow',
      });
      const landingBody = await landingResp.text();

      return jsonResponse({
        jsSize: js.length,
        loadPricesContext: findContext(js, 'loadPrices'),
        oxomiContext: findContext(js, 'OxomiArticleSearch'),
        searchResultContext: findContext(js, 'SearchResultProductListContentContainer'),
        loadPriceDataContext: findContext(js, 'LoadPriceData'),
        fetchPatterns: [...new Set(fetchPatterns)].slice(0, 20),
        axiosPatterns: [...new Set(axiosPatterns)].slice(0, 20),
        urlPatterns: [...new Set(urlPatterns)].slice(0, 20),
        oxomiGeneral: {
          status: oxomiGeneral.status,
          contentType: oxomiGeneral.headers.get('content-type'),
          bodyLength: oxomiGeneralBody.length,
          body: oxomiGeneralBody.substring(0, 1000),
        },
        landingPage: {
          status: landingResp.status,
          contentType: landingResp.headers.get('content-type'),
          bodyLength: landingBody.length,
          body: landingBody.substring(0, 1000),
        },
      });
    }

    if (step === 'v5-searchhtml') {
      // Examine search page HTML to find product IDs and data structure
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');
      if (!ean) return errorResponse('ean Parameter benoetigt');

      const cookies = await loginToGautzsch(username, password);

      const searchResp = await fetch(`${GAUTZSCH_V5_BASE}/Search?q=${encodeURIComponent(ean)}`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA },
        redirect: 'follow',
      });
      const html = await searchResp.text();

      // Find data-* attributes with product/article info
      const dataAttrs = [...html.matchAll(/data-(?:id|product|article|productid|articleid|fif)[^=\s]*="([^"]+)"/gi)].map(m => m[0]);

      // Look for product IDs in common patterns
      const productIdPatterns = [
        ...html.matchAll(/data-productid="(\d+)"/gi),
        ...html.matchAll(/data-id="(\d+)"/gi),
        ...html.matchAll(/data-article-id="([^"]+)"/gi),
        ...html.matchAll(/product-id[^=]*="([^"]+)"/gi),
      ].map(m => m[0]);

      // Look for JSON blobs embedded in the page
      const jsonBlobs = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].substring(0, 500));

      // Find inline JSON data (window.__xxx = {...})
      const inlineData = [...html.matchAll(/window\.[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(\{[^;]{0,2000})/g)].map(m => m[0].substring(0, 500));

      // Sample 6 sections spread across the HTML
      const len = html.length;
      const samples = [0, 0.15, 0.30, 0.45, 0.60, 0.75, 0.90].map(pct => ({
        offset: Math.floor(pct * len),
        text: html.substring(Math.floor(pct * len), Math.floor(pct * len) + 1500),
      }));

      // Look for elements that contain both a product name and a number (likely product cards)
      const articleCards = [...html.matchAll(/(?:article|product|item|result)[^>]*id="([^"]+)"[^>]*>[\s\S]{0,500}/gi)].slice(0, 5).map(m => m[0].substring(0, 300));

      // Search for EAN in page
      const eanIdx = html.indexOf(ean);
      const eanContext = eanIdx >= 0 ? html.substring(Math.max(0, eanIdx - 200), eanIdx + 400) : null;

      return jsonResponse({
        htmlLength: html.length,
        dataAttrs: dataAttrs.slice(0, 30),
        productIdPatterns: productIdPatterns.slice(0, 20),
        jsonBlobs: jsonBlobs.slice(0, 5),
        inlineData: inlineData.slice(0, 5),
        articleCards: articleCards,
        eanContext,
        samples,
      });
    }

    if (step === 'v5-endpoints') {
      // Test only the discovered API endpoints from app.min.js
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');
      if (!ean) return errorResponse('ean Parameter benoetigt');

      const cookies = await loginToGautzsch(username, password);
      debug.cookies = cookies.substring(0, 100);
      debug.results = [];

      const endpoints = [
        { method: 'GET', url: `/ProductList/OxomiArticleSearch?searchTerm=${encodeURIComponent(ean)}` },
        { method: 'GET', url: `/Product/GetPricesAndAvailabilities?ean=${encodeURIComponent(ean)}` },
        { method: 'GET', url: `/ProductList/LoadPriceData?ean=${encodeURIComponent(ean)}` },
        { method: 'GET', url: `/JsonData/Get?q=${encodeURIComponent(ean)}` },
        { method: 'GET', url: `/Search?q=${encodeURIComponent(ean)}&handler=GetResults` },
        { method: 'GET', url: `/Search?handler=ArticleSearch&searchTerm=${encodeURIComponent(ean)}` },
      ];

      for (const ep of endpoints) {
        try {
          const resp = await fetch(`${GAUTZSCH_V5_BASE}${ep.url}`, {
            method: ep.method,
            headers: {
              'Cookie': cookies,
              'User-Agent': BROWSER_UA,
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json, text/javascript, */*; q=0.01',
            },
            redirect: 'follow',
          });
          const body = await resp.text();
          debug.results.push({
            url: ep.url,
            status: resp.status,
            contentType: resp.headers.get('content-type') || '',
            bodyLength: body.length,
            bodySnippet: body.substring(0, 600),
          });
        } catch (e) {
          debug.results.push({ url: ep.url, error: e.message });
        }
      }

      return jsonResponse(debug);
    }

    if (step === 'v5-api') {
      // Test various API endpoints on v5.onlinesystem.de
      if (!username || !password) return errorResponse('username und password Parameter benoetigt');
      if (!ean) return errorResponse('ean Parameter benoetigt');

      const cookies = await loginToGautzsch(username, password);
      debug.cookies = cookies.substring(0, 100);

      const apiEndpoints = [
        `/api/search?q=${encodeURIComponent(ean)}`,
        `/api/articles?ean=${encodeURIComponent(ean)}`,
        `/api/catalogue/search?term=${encodeURIComponent(ean)}`,
        `/api/products/search?q=${encodeURIComponent(ean)}`,
        `/Search/Json?q=${encodeURIComponent(ean)}`,
        `/api/Search?q=${encodeURIComponent(ean)}`,
        `/api/article/${encodeURIComponent(ean)}`,
        `/api/v1/search?q=${encodeURIComponent(ean)}`,
      ];

      debug.apiResults = [];
      for (const endpoint of apiEndpoints) {
        const url = `${GAUTZSCH_V5_BASE}${endpoint}`;
        const resp = await fetch(url, {
          headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
          redirect: 'follow',
        });
        const contentType = resp.headers.get('content-type') || '';
        const body = await resp.text();
        debug.apiResults.push({
          url: endpoint,
          status: resp.status,
          contentType,
          bodyLength: body.length,
          bodySnippet: body.substring(0, 300),
        });
      }

      // Also fetch the search page and look for script bundles + HTMX patterns
      const searchPageResp = await fetch(`${GAUTZSCH_V5_BASE}/search?q=${encodeURIComponent(ean)}`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA },
        redirect: 'follow',
      });
      const searchHtml = await searchPageResp.text();

      // Find script bundles
      const scriptUrls = [...searchHtml.matchAll(/<script[^>]*src="([^"]+\.js[^"]*)"/gi)].map(m => m[1]);
      debug.scriptBundles = scriptUrls;

      // Check for HTMX (hx-get, hx-target)
      const htmxPatterns = [...searchHtml.matchAll(/hx-(?:get|post|target|swap)="([^"]+)"/gi)].map(m => m[0]);
      debug.htmxPatterns = htmxPatterns.slice(0, 20);

      // Check for app.js or similar direct references to API
      const inlineApiCalls = [...searchHtml.matchAll(/["'](\/(?:api|data|service)[^"'<>]{0,100})["']/g)].map(m => m[1]);
      debug.inlineApiUrls = [...new Set(inlineApiCalls)].slice(0, 20);

      // Test X-Requested-With: XMLHttpRequest (ASP.NET returns partial/JSON for AJAX requests)
      const xhrEndpoints = [
        `/Search?q=${encodeURIComponent(ean)}`,
        `/Search/Json?q=${encodeURIComponent(ean)}`,
        `/ProductList?q=${encodeURIComponent(ean)}`,
      ];
      debug.xhrResults = [];
      for (const endpoint of xhrEndpoints) {
        const resp = await fetch(`${GAUTZSCH_V5_BASE}${endpoint}`, {
          headers: {
            'Cookie': cookies,
            'User-Agent': BROWSER_UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*',
          },
          redirect: 'follow',
        });
        const body = await resp.text();
        debug.xhrResults.push({
          url: endpoint,
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          bodyLength: body.length,
          bodySnippet: body.substring(0, 500),
        });
      }

      // Test the discovered API endpoints
      const discoveredEndpoints = [
        `/Product/GetPricesAndAvailabilities?ean=${encodeURIComponent(ean)}`,
        `/Product/GetPricesAndAvailabilities?searchTerm=${encodeURIComponent(ean)}`,
        `/ProductList/LoadPriceData?ean=${encodeURIComponent(ean)}`,
        `/ProductList/OxomiArticleSearch?searchTerm=${encodeURIComponent(ean)}`,
        `/JsonData/Get?q=${encodeURIComponent(ean)}`,
        `/JsonData/Get`,
      ];
      debug.discoveredResults = [];
      for (const endpoint of discoveredEndpoints) {
        const resp = await fetch(`${GAUTZSCH_V5_BASE}${endpoint}`, {
          headers: {
            'Cookie': cookies,
            'User-Agent': BROWSER_UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
          },
          redirect: 'follow',
        });
        const body = await resp.text();
        debug.discoveredResults.push({
          url: endpoint,
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          bodyLength: body.length,
          bodySnippet: body.substring(0, 500),
        });
      }

      // Fetch the app.min.js and search for API patterns
      const appJsResp = await fetch(`${GAUTZSCH_V5_BASE}/sec/js/app.min.js`, {
        headers: { 'Cookie': cookies, 'User-Agent': BROWSER_UA },
      });
      if (appJsResp.ok) {
        const appJs = await appJsResp.text();
        debug.appJsSize = appJs.length;
        // Find URL patterns (fetch, api, search)
        const apiPatternsInJs = [...appJs.matchAll(/["'](\/(?:api|data|search|product|article|json)[^"'<>{}]{0,80})["']/gi)]
          .map(m => m[1])
          .filter(u => u.length > 3);
        debug.apiPatternsInJs = [...new Set(apiPatternsInJs)].slice(0, 40);
      }

      return jsonResponse(debug);
    }

    return errorResponse('Unbekannter step. Verwende: login-page, login, v5-login, v5-api, post-debug, search');
  } catch (error) {
    debug.error = error.message;
    debug.stack = error.stack;
    return jsonResponse(debug, 500);
  }
}

// ========================================
// Request Handler
// ========================================

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return jsonResponse({ status: 'ok', service: 'supplier-proxy', suppliers: ['fega', 'gautzsch'] });
    }

    // Debug endpoint for Gautzsch reverse-engineering
    if (url.pathname === '/debug-gautzsch') {
      return handleDebugGautzsch(url);
    }

    // Search endpoint
    if (url.pathname === '/search') {
      const ean = url.searchParams.get('ean');
      const supplier = url.searchParams.get('supplier') || 'fega';
      const username = url.searchParams.get('username');
      const password = url.searchParams.get('password');

      if (!ean) {
        return errorResponse('Parameter "ean" fehlt');
      }
      if (!username || !password) {
        return errorResponse('Parameter "username" und "password" fehlen');
      }

      if (supplier === 'fega') {
        try {
          const sessionCookie = await loginToFega(username, password);
          const html = await searchFega(ean, sessionCookie);
          const product = parseFegaProductFromHTML(html, ean);

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

      if (supplier === 'gautzsch') {
        try {
          const cookies = await loginToGautzsch(username, password);
          const oxomiProduct = await searchGautzsch(ean, cookies);

          if (!oxomiProduct) {
            return jsonResponse({
              productName: null,
              manufacturer: null,
              articleNumber: null,
              price: null,
              available: false,
              deliveryDays: null,
            });
          }

          const product = parseGautzschProduct(oxomiProduct, ean);
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
          console.error('Gautzsch proxy error:', error);
          return errorResponse('Fehler: ' + error.message, 502);
        }
      }

      return errorResponse(`Unbekannter supplier "${supplier}". Verwende: fega, gautzsch`);
    }

    return errorResponse('Unbekannter Pfad. Verwende GET /search?supplier=fega|gautzsch&ean=...&username=...&password=...', 404);
  },
};
