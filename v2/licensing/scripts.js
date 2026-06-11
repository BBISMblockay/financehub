// ─── State ────────────────────────────────────────────────────────────────────
const files = { shopify: null, reftables: null, attrmap: null, template: null };
let currentMode = 'online'; // 'online' | 'fanatics'

// ─── Constants ────────────────────────────────────────────────────────────────
const CONTRACT_NUM     = 5199;
const CONTRACT_VERSION = "B";
const TERRITORY        = "USA";
const RETAILER_CODE    = 5431;
const RETAILER_NAME    = "Baseballism";
const ROYALTY_RATE     = 12;
const LANGUAGE         = "current";
const DIST_CHANNEL     = "DC";
const CURRENCY         = "USD";
const CONVERSION_RATE  = 1;

// ─── Hard Goods Product Type Map ─────────────────────────────────────────────
// Maps Shopify HardGoods product types → Fanatics attribute code + product category string
const HG_PRODUCT_MAP = {
  'canvas totes':  { attrCode: 10060747, product: 'Hard Goods > Bags & Luggage > Tote Bags' },
  'handbag strap': { attrCode: 10060747, product: 'Hard Goods > Bags & Luggage > Other Bags & Accessories' },
  'handbags':      { attrCode: 10060747, product: 'Hard Goods > Bags & Luggage > Tote Bags' },
  'key chain':     { attrCode: 10062362, product: 'Hard Goods > Jewelry > Money Clips' },
  "men's wallet":  { attrCode: 10062362, product: 'Hard Goods > Personal/Fashion Accessories > Wallets/Purses > Adult' },
  'poster':        { attrCode: 10062330, product: 'Hard Goods > Publishing/Posters/Art > Posters' },
};

// ─── Store → Fanatics Channel ─────────────────────────────────────────────────
const CHANNEL_ONLINE    = 'Licensee Direct > Licensee Direct to Consumer > Online > Licensee owned or affiliated website';
const CHANNEL_BRICKMORTAR = 'Licensee Direct > Licensee Direct to Consumer > Brick & Mortar';

// ─── Asset Code → Full Team Name ─────────────────────────────────────────────
// Used for the Property column in the Fanatics submission
const ASSET_FULL_NAME = {
  'TEX':'Texas Rangers',       'LA':'Los Angeles Dodgers',  'SF':'San Francisco Giants',
  'ATH':'Athletics',           'ATL':'Atlanta Braves',      'CHI':'Chicago Cubs',
  'STL':'St. Louis Cardinals', 'HOU':'Houston Astros',      'NY':'New York Mets',
  'NYY':'New York Yankees',    'BOS':'Boston Red Sox',      'CWS':'Chicago White Sox',
  'SEA':'Seattle Mariners',    'SD':'San Diego Padres',     'PHI':'Philadelphia Phillies',
  'BAL':'Baltimore Orioles',   'DET':'Detroit Tigers',      'WSH':'Washington Nationals',
  'MIA':'Miami Marlins',       'MIL':'Milwaukee Brewers',   'ARI':'Arizona Diamondbacks',
  'CIN':'Cincinnati Reds',     'PIT':'Pittsburgh Pirates',  'KC':'Kansas City Royals',
  'MIN':'Minnesota Twins',     'TB':'Tampa Bay Rays',       'TOR':'Toronto Blue Jays',
  'ANA':'Los Angeles Angels',  'COL':'Colorado Rockies',    'CLEG':'Cleveland Guardians',
};

// ─── Event Config (update each year) ─────────────────────────────────────────
// Multi-team MLB event products — asset code left blank, team set to "MLB".
// Add a new array each year (e.g. EVENT_KEYWORDS_26) and include it in ALL_EVENT_KEYWORDS.
const EVENT_KEYWORDS_25 = ["allstars", "openingday"];
// const EVENT_KEYWORDS_26 = ["allstars", "openingday"];

const ALL_EVENT_KEYWORDS = [...EVENT_KEYWORDS_25];

// ─── Team Nickname Map ────────────────────────────────────────────────────────
const SKU_NICKNAME_MAP = {
  "rangers":"TEX",    "dodgers":"LA",     "giants":"SF",      "athletics":"ATH",
  "braves":"ATL",     "cubs":"CHI",       "cardinals":"STL",  "astros":"HOU",
  "mets":"NY",        "yankees":"NYY",    "redsox":"BOS",     "red sox":"BOS",
  "whitesox":"CWS",   "white sox":"CWS",  "mariners":"SEA",   "padres":"SD",
  "phillies":"PHI",   "orioles":"BAL",    "tigers":"DET",     "nationals":"WSH",
  "marlins":"MIA",    "brewers":"MIL",    "dbacks":"ARI",     "diamondbacks":"ARI",
  "reds":"CIN",       "pirates":"PIT",    "royals":"KC",      "twins":"MIN",
  "rays":"TB",        "bluejays":"TOR",   "blue jays":"TOR",  "angels":"ANA",
  "rockies":"COL",    "guardians":"CLEG",
};

// ─── Asset Code Remaps for MLB submission ────────────────────────────────────
// MLB groups city-shared franchises under one code in the submission file.
// Update this map if MLB ever changes how they consolidate teams.
// No remaps currently needed — CHI (Cubs) and CWS (White Sox) submit separately.
const ASSET_CODE_REMAP = {};

// ─── Sheets to process ───────────────────────────────────────────────────────
const SHEETS_TO_PROCESS = [
  { sheetName: "MLB Retail-Online", label: "Online" },
];

// ─── Persistent file keys (saved between sessions) ───────────────────────────
const PERSISTENT_KEYS = ['reftables', 'attrmap', 'template'];

function formatSavedDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function markSlotLoaded(key, name, savedDate) {
  document.getElementById(`slot-${key}`).classList.add('loaded');
  document.getElementById(`icon-${key}`).textContent = '✅';
  const dateStr = savedDate ? ` — saved ${formatSavedDate(savedDate)}` : '';
  document.getElementById(`fname-${key}`).textContent = `${name}${dateStr}`;
  document.getElementById(`badge-${key}`).textContent = 'Ready';
  document.getElementById(`badge-${key}`).className = 'slot-badge ready';
}

// ─── Mode Selection ───────────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;

  // Update mode card active states
  document.getElementById('mode-online').classList.toggle('active', mode === 'online');
  document.getElementById('mode-fanatics').classList.toggle('active', mode === 'fanatics');
  document.getElementById('check-online').textContent   = mode === 'online'   ? '✓' : '';
  document.getElementById('check-fanatics').textContent = mode === 'fanatics' ? '✓' : '';

  // Update shopify slot description based on mode
  const shopDesc = document.getElementById('desc-shopify');
  if (shopDesc) {
    shopDesc.textContent = mode === 'fanatics'
      ? 'Monthly sales file — needs sheet "HardGoods"'
      : 'Monthly sales file — needs sheet "MLB Retail-Online"';
  }

  // Show/hide file slots based on mode
  document.querySelectorAll('.file-slot').forEach(slot => {
    const isOnline   = slot.classList.contains('mode-online');
    const isFanatics = slot.classList.contains('mode-fanatics');
    const show = (mode === 'online' && isOnline) || (mode === 'fanatics' && isFanatics);
    slot.classList.toggle('hidden', !show);
  });

  // Reset log / downloads / errors on mode switch
  clearLog();
  checkReady();
}

// ─── File Loading ─────────────────────────────────────────────────────────────
function loadFile(key, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const data = new Uint8Array(e.target.result);
    const savedDate = new Date().toISOString();
    files[key] = { data, name: file.name, savedDate };
    markSlotLoaded(key, file.name, savedDate);
    showToast("✅ " + file.name + " loaded successfully");

    // Persist reference files to localStorage
    if (PERSISTENT_KEYS.includes(key)) {
      try {
        // Safe base64 encoding for large files (no spread operator)
        let binary = "";
        for (let i = 0; i < data.length; i++) {
          binary += String.fromCharCode(data[i]);
        }
        const base64 = btoa(binary);
        localStorage.setItem(`mlb_file_${key}`, JSON.stringify({
          name: file.name,
          savedDate,
          data: base64,
        }));
      } catch (e) {
        console.warn('Could not save to localStorage (file may be too large):', e);
      }
    }

    checkReady();
  };
  reader.readAsArrayBuffer(file);
}

// ─── Load persisted files on startup ─────────────────────────────────────────
function loadPersistedFiles() {
  for (const key of PERSISTENT_KEYS) {
    try {
      const stored = localStorage.getItem(`mlb_file_${key}`);
      if (!stored) continue;
      const { name, savedDate, data: base64 } = JSON.parse(stored);
      const binary = atob(base64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      files[key] = { data: bytes, name, savedDate };
      markSlotLoaded(key, name, savedDate);
    } catch (e) {
      console.warn(`Could not restore ${key} from localStorage:`, e);
    }
  }
  checkReady();
}

// ─── Toast notification ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function checkReady() {
  const REQUIRED = currentMode === 'fanatics'
    ? ['shopify']
    : ['shopify', 'reftables', 'attrmap', 'template'];

  const allReady = REQUIRED.every(k => files[k] !== null);
  document.getElementById("run-btn").disabled = !allReady;

  const LABELS = {
    shopify:   "Shopify Export",
    reftables: "Reference Tables",
    attrmap:   "Attribute Mapping",
    template:  "MLB Template",
  };
  const missing = REQUIRED.filter(k => files[k] === null).map(k => LABELS[k]);

  const el = document.getElementById("missing-files");
  el.textContent = missing.length > 0
    ? missing.join(", ") + " needed to generate"
    : "";
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const area = document.getElementById('log-area');
  area.classList.add('visible');
  const line = document.createElement('p');
  line.className = `log-line ${type}`;
  line.textContent = msg;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
}

function clearLog() {
  const area = document.getElementById('log-area');
  area.innerHTML = '';
  area.classList.remove('visible');
  document.getElementById('error-block').classList.remove('visible');
  document.getElementById('downloads').classList.remove('visible');
  document.getElementById('downloads').innerHTML = '<div class="downloads-label">Downloads Ready</div>';
}

// ─── Reference Tables ─────────────────────────────────────────────────────────
function loadReferenceTables(wb) {
  const ws = wb.Sheets['LICENSE_ASSETS'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const assetToTeam = {}, teamToAsset = {};
  for (let i = 1; i < rows.length; i++) {
    const [code, asset, , assetType] = rows[i];
    if (assetType === 'Team' && code && asset) {
      const c = String(code).trim();
      const a = String(asset).trim();
      assetToTeam[c] = a;
      // Only set the first occurrence — base team code (e.g. ATL) comes before
      // mascot/event variants (ATLM, ATLINTE) so first-wins gives us the right code
      if (!teamToAsset[a.toLowerCase()]) teamToAsset[a.toLowerCase()] = c;
    }
  }
  return { assetToTeam, teamToAsset };
}

// ─── Attribute Mapping ────────────────────────────────────────────────────────
function loadAttributeMapping(wb) {
  const ws = wb.Sheets['Apparel'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Key includes MLB Product ID to disambiguate entries that share prodType+gender
  // (e.g. 5199-2 Outerwear/Fleece and 5199-5 Outerwear/Lightweight both have Adult+Outerwear)
  const detailedMapping = {};
  for (let i = 3; i < rows.length; i++) {
    const [mlbProdId, attrCode, , , brand, , gender, prodType, descriptive] = rows[i];
    if (!prodType || brand !== 'Genuine Merchandise') continue;
    const key = `${String(mlbProdId).trim()}||${String(prodType).trim().toLowerCase()}||${String(gender || '').trim().toLowerCase()}`;
    detailedMapping[key] = {
      mlbProductId: String(mlbProdId),
      attributeCode: attrCode,
      licenseeDesc: descriptive || prodType,
    };
  }

  // Map Shopify product types to [mlbProdId, attrProdType, gender].
  // Notes:
  // - All outerwear (sweatshirts and jackets) submits as Lightweight Outerwear (5199-5).
  //   Fleece (5199-2) is not used by Baseballism.
  // - Youth Shorts and Swim Trunks both roll up into Adult Bottoms (5199-3 adult).
  //   Verified against correct file: youth shorts qty + adult shorts qty = correct adult bottoms total.
  const SHOPIFY_TO_ATTR = {
    "t-shirts":         ["5199-1", "t-shirts",  "adult"],
    "women":            ["5199-1", "t-shirts",  "women"],
    "youth":            ["5199-1", "t-shirts",  "youth"],
    "shorts":           ["5199-3", "pants",     "adult"],
    "swim trunks":      ["5199-3", "pants",     "adult"],   // rolls into Adult Bottoms
    "youth shorts":     ["5199-3", "pants",     "adult"],   // rolls into Adult Bottoms
    "sweatshirt":       ["5199-5", "outerwear", "adult"],   // Lightweight Outerwear
    "youth sweatshirt": ["5199-5", "outerwear", "youth"],   // Lightweight Outerwear
    "men's jacket":     ["5199-5", "outerwear", "adult"],   // Lightweight Outerwear
    "youth jacket":     ["5199-5", "outerwear", "youth"],   // Lightweight Outerwear
  };

  const mapping = {};
  for (const [shopifyType, [mlbProdId, attrProdType, gender]] of Object.entries(SHOPIFY_TO_ATTR)) {
    const key = `${mlbProdId}||${attrProdType}||${gender}`;
    if (detailedMapping[key]) {
      mapping[shopifyType] = detailedMapping[key];
    }
  }

  return mapping;
}

// ─── Team Extraction ──────────────────────────────────────────────────────────
function extractTeamFromSku(sku, productName, assetToTeam, teamToAsset) {
  if (!sku) return { assetCode: null, teamName: null, isEvent: false };
  const fullStr = `${sku} ${productName || ''}`.toLowerCase();

  // 1. Check for known multi-team event keywords
  for (const kw of ALL_EVENT_KEYWORDS) {
    if (fullStr.includes(kw.toLowerCase())) {
      return { assetCode: null, teamName: 'MLB', isEvent: true };
    }
  }

  // 2. Parentheses pattern e.g. (Rangers)
  const match = sku.match(/\(([^)]+)\)/);
  if (match) {
    const nickname = match[1].trim();
    const nickLower = nickname.toLowerCase().replace(/\s/g, '');
    const direct = SKU_NICKNAME_MAP[nickname.toLowerCase()] || SKU_NICKNAME_MAP[nickLower];
    if (direct) return { assetCode: direct, teamName: assetToTeam[direct] || nickname, isEvent: false };
    for (const [tname, code] of Object.entries(teamToAsset)) {
      if (nickname.toLowerCase().includes(tname) || tname.includes(nickname.toLowerCase())) {
        return { assetCode: code, teamName: assetToTeam[code] || nickname, isEvent: false };
      }
    }
    if (assetToTeam[nickname.toUpperCase()]) {
      return { assetCode: nickname.toUpperCase(), teamName: assetToTeam[nickname.toUpperCase()], isEvent: false };
    }
  }

  // 3. Fallback: scan full string word by word (catches e.g. BravesFlag)
  const words = sku.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  for (let len = 2; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const candidate = words.slice(i, i + len).join('');
      const code = SKU_NICKNAME_MAP[candidate] || SKU_NICKNAME_MAP[words.slice(i, i + len).join(' ')];
      if (code) return { assetCode: code, teamName: assetToTeam[code] || candidate, isEvent: false };
    }
  }

  return { assetCode: null, teamName: null, isEvent: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function stripDollar(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[$,]/g, '').trim()) || 0;
}

function parseMonth(moName) {
  if (!moName) return { abbr: '', year: 2026 };
  const abbr = String(moName).trim().toUpperCase().slice(0, 3);
  return { abbr, year: 2026 };
}


// ─── Product type fallback from product name ──────────────────────────────────
const PRODUCT_NAME_KEYWORDS = [
  { keywords: ["t-shirt", "tee"],                         type: "T-Shirts"     },
  { keywords: ["mesh shorts", "sweat shorts"],            type: "Shorts"       },
  { keywords: ["sweatshirt", "hoodie", "hoody"],          type: "Sweatshirt"   },
  { keywords: ["jacket"],                                 type: "Men's Jacket" },
];

function detectProductTypeFromName(productName) {
  if (!productName) return null;
  const lower = String(productName).toLowerCase();
  for (const { keywords, type } of PRODUCT_NAME_KEYWORDS) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return null;
}
// ─── Enrich Shopify Sheet ─────────────────────────────────────────────────────
function enrichSheet(ws, assetToTeam, teamToAsset, attrMapping) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const enriched = [], flagged = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku         = row['SKU'];
    const productName = row['Product name'];
    const productType = row['Product type'];
    const qty         = row['Total quantity sold'] || 0;
    const gross       = stripDollar(row['Total gross sales']);
    const discounts   = stripDollar(row['Total discounts']);
    const refunds     = stripDollar(row['Total refunds']);
    const netSales    = stripDollar(row['Total net sales']);
    const totalSales  = stripDollar(row['Total Sales']);
    const moName      = row['Mo Name'];
    const store       = row['Store'];

    const { assetCode, teamName, isEvent } = extractTeamFromSku(sku, productName, assetToTeam, teamToAsset);
    // Product type: use column first, fall back to product name keyword detection
    const resolvedType = (productType && String(productType).trim())
      || detectProductTypeFromName(productName);
    const prodKey  = resolvedType ? String(resolvedType).trim().toLowerCase() : '';
    const prodInfo = attrMapping[prodKey] || null;
    const usedFallback = !productType && resolvedType;

    const flagReasons = [];
    if (!assetCode && !isEvent) flagReasons.push(`Unknown team in SKU: ${sku}`);
    if (!prodInfo) flagReasons.push(`Unknown product type — not found in column or product name: "${productName}"`);
    if (usedFallback && prodInfo) console.log(`Fallback used for row ${i+2}: "${productName}" -> ${resolvedType}`);

    enriched.push({
      productName, sku, productType, qty, gross, discounts, refunds,
      netSales, totalSales, moName, store, teamName, assetCode,
      retailerCode:  RETAILER_CODE,
      retailerName:  RETAILER_NAME,
      licenseeDesc:  prodInfo ? prodInfo.licenseeDesc  : null,
      mlbProductId:  prodInfo ? prodInfo.mlbProductId  : null,
      attributeCode: prodInfo ? prodInfo.attributeCode : null,
      royaltyRate: ROYALTY_RATE,
      flagged: flagReasons.length > 0,
      flagReasons,
      isEvent,
      rowNum: i + 2,
    });

    if (flagReasons.length > 0) flagged.push(enriched.length - 1);
  }

  return { enriched, flagged };
}

// ─── Write BBSM File ──────────────────────────────────────────────────────────
function writeBBSM(enriched, label) {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Product name','SKU','Product type','Total quantity sold',
    'Total gross sales','Total discounts','Total refunds','Total net sales',
    'Total Sales','Mo Name','Store','Normalized Team / Event',
    'Asset Code','Retailer Code','Retailer Name','Licensee Description',
    'MLB Product ID','Attribute Code','Royalty Rate','Unit Gross Price',
  ];
  const wsData = [headers];
  for (const r of enriched) {
    wsData.push([
      r.productName, r.sku, r.productType, r.qty,
      r.gross, r.discounts, r.refunds, r.netSales,
      r.totalSales, r.moName, r.store, r.teamName,
      r.assetCode, r.retailerCode, r.retailerName, r.licenseeDesc,
      r.mlbProductId, r.attributeCode, r.royaltyRate, null,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, label);
  return wb;
}

// ─── Group enriched rows by Asset Code + Attribute Code ──────────────────────
function groupRows(enriched, assetToTeam) {
  const groups = new Map();

  for (const r of enriched) {
    // Event products (Opening Day, All Stars, etc.) have no asset code — exclude from submission
    if (r.isEvent) continue;

    const rawCode   = r.assetCode || 'MLB';
    const assetCode = ASSET_CODE_REMAP[rawCode] || rawCode;
    const teamName  = assetCode !== rawCode
      ? (assetToTeam[assetCode] || assetCode)
      : r.teamName;
    const key = `${assetCode}||${r.attributeCode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        moName:        r.moName,
        assetCode,
        teamName,
        mlbProductId:  r.mlbProductId,
        attributeCode: r.attributeCode,
        licenseeDesc:  r.licenseeDesc,
        retailerCode:  r.retailerCode,
        retailerName:  r.retailerName,
        royaltyRate:   r.royaltyRate,
        qty:           0,
        gross:         0,
        discounts:     0,
        refunds:       0,
      });
    }
    const g = groups.get(key);
    g.qty       += (r.qty       || 0);
    g.gross     += (r.gross     || 0);
    g.discounts += (r.discounts || 0);
    g.refunds   += (r.refunds   || 0);
  }

  return Array.from(groups.values()).sort((a, b) => {
    const assetA = String(a.assetCode || '');
    const assetB = String(b.assetCode || '');
    if (assetA !== assetB) return assetA.localeCompare(assetB);
    return (a.attributeCode || 0) - (b.attributeCode || 0);
  });
}

// ─── Parse Fanatics Hard Goods CSV ───────────────────────────────────────────
// CSV columns (0-indexed, based on Fanatics Hard Goods report format):
//  0  Territory  |  1  Property  |  2  Asset Code  |  3  Channel
//  4  Retailer   |  5  Product   |  6  Attribute Code  |  7  Description
//  8  Rate Type  |  9  List Price | 10  Unit Price | 11  Units
// 12  Net Sales  | 13  Currency  | 14  Reporting Period | 15  Year
//
// Groups rows by Asset Code + Attribute Code, computing:
//   gross     = sum of (list_price × units)   per row in group
//   discounts = sum of (list_price − unit_price) × units  per row
//   refunds   = 0 (no return rows in data)
//   netSales  = sum of net_sales per row
// ─── Parse HardGoods Sheet from Shopify Export ───────────────────────────────
// Reads the HardGoods sheet, maps product types to Fanatics attribute codes,
// extracts team via same SKU scan logic as Retail Online, maps store to channel,
// groups by Asset Code + Attribute Code + Channel.
// Derive Fanatics product category from product name for attribute code 10062362
// Money Clip Wallets → Jewelry > Money Clips
// Scorebook/Bifold Wallets → Wallets/Purses > Adult
// Key Chain → Jewelry > Money Clips
function getWalletCategory(productName) {
  const lower = productName.toLowerCase();
  if (lower.includes('money clip') || lower.includes('key chain')) {
    return 'Hard Goods > Jewelry > Money Clips';
  }
  return 'Hard Goods > Personal/Fashion Accessories > Wallets/Purses > Adult';
}

function parseHardGoodsSheet(ws) {
  const rows    = XLSX.utils.sheet_to_json(ws, { defval: null });
  const output  = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row         = rows[i];
    const productName = String(row['Product Name']        || '').trim();
    const sku         = String(row['Product SKU']         || '').trim();
    const productType = String(row['Product Type']        || '').trim().toLowerCase();
    const qty         = Number(row['Total Quantity Sold']) || 0;
    const gross       = Number(row['Total Gross Sales'])   || 0;
    const discount    = Number(row['Total Discount'])      || 0;
    const refund      = Number(row['Total Refund'])        || 0;
    const netSales    = Number(row['Total Net sales'])     || 0;
    const mo          = String(row['Mo'] || 'APR').toUpperCase().slice(0, 3);

    // Skip MiLB rows
    if (row['MLB/MiLB'] !== 'MLB') continue;

    // Skip zero-quantity rows (returns that wiped out all sales)
    if (qty === 0) continue;

    // Map product type → attribute code + Fanatics product category
    const prodInfo = HG_PRODUCT_MAP[productType];
    if (!prodInfo) {
      skipped.push(`Row ${i + 2}: Unknown product type "${productType}"`);
      continue;
    }

    // For wallets/key chains, refine product category by product name
    const product = prodInfo.attrCode === 10062362
      ? getWalletCategory(productName)
      : prodInfo.product;

    // Extract team — same logic as Retail Online
    const { assetCode, teamName } = extractTeamFromSku(sku, productName, ASSET_FULL_NAME, {});
    if (!assetCode) {
      skipped.push(`Row ${i + 2}: Could not find team in "${sku}" / "${productName}"`);
      continue;
    }

    // All stores → same Online channel (MLB treats all Baseballism sales as licensee DTC)
    output.push({
      mo,
      assetCode,
      teamName:  ASSET_FULL_NAME[assetCode] || teamName,
      channel:   CHANNEL_ONLINE,
      product,
      attrCode:  prodInfo.attrCode,
      productName,
      qty,
      gross,
      discount,
      refund,
      netSales,
    });
  }

  // Sort: attrCode → product subcategory → assetCode
  // This matches the example layout: Other Bags before Tote Bags, Jewelry before Wallets/Purses, etc.
  output.sort((a, b) => {
    if ((a.attrCode || 0) !== (b.attrCode || 0)) return (a.attrCode || 0) - (b.attrCode || 0);
    if (a.product !== b.product) return a.product.localeCompare(b.product);
    return a.assetCode.localeCompare(b.assetCode);
  });

  return { groups: output, skipped };
}

// ─── Write Fanatics Submission File ──────────────────────────────────────────
// Outputs in the Fanatics BrandComply format — 16 columns matching the Sample Sheet.
// The # prefix on the header row tells BrandComply to skip it on import.
function writeFanaticsSubmission(groups) {
  const headers = [
    '#Territory', 'Property', 'Asset Code',
    'Channel', 'Retailer Code', 'Product', 'Attribute Code',
    'SKU/Product Description', 'Royalty Rate Type',
    'List Price', 'Unit Price', 'Units', 'Net Sales',
    'Currency', 'Reporting Period', 'Year',
  ];

  const wsData = [headers];

  for (const g of groups) {
    // qty is guaranteed > 0 (zero rows are skipped in parse)
    const listPrice = +(g.gross    / g.qty).toFixed(2);
    const unitPrice = +(g.netSales / g.qty).toFixed(2);

    wsData.push([
      'North America > United States of America',
      g.teamName,
      g.assetCode,
      g.channel,
      '1217 – Direct to Consumer',
      g.product,
      g.attrCode,
      g.productName,
      'Non Player',
      listPrice,
      unitPrice,
      g.qty,
      +g.netSales.toFixed(2),
      'USD',
      g.mo,
      2026,
    ]);
  }

  // Output as CSV — Fanatics BrandComply accepts CSV uploads
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const csv = XLSX.utils.sheet_to_csv(ws);
  return { csv, wsData };
}

// ─── Write MLB Submission File ────────────────────────────────────────────────
function writeMLBSubmission(enriched, hardGoodsGroups, templateWb, assetToTeam) {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Month','Year','MLB Contract #','MLB Contract Version','MLB Product ID',
    'Licensee Description','MLB Territory ID','MLB Retailer Code','Licensee Retailer Name',
    'Asset','Attribute Code','Retail/Wholesale Price','Quantity',
    'Gross Sales','Less MLB Allowed Discounts','Less Returns','Net Sales',
    'Royalty Rate','Per Unit Fee','MLB Share of Royalties',
    'Language/Participation','Distribution Channel','Currency','Conversion Rate','Option1',
  ];
  const wsData = [headers];

  // Group apparel rows, then merge in hard goods (already grouped), sort combined
  const apparelGroups = groupRows(enriched, assetToTeam);
  const allGroups = [...apparelGroups, ...(hardGoodsGroups || [])].sort((a, b) => {
    const assetA = String(a.assetCode || '');
    const assetB = String(b.assetCode || '');
    if (assetA !== assetB) return assetA.localeCompare(assetB);
    return (a.attributeCode || 0) - (b.attributeCode || 0);
  });

  for (let i = 0; i < allGroups.length; i++) {
    const r = allGroups[i];
    const rowNum = i + 2;
    const { abbr, year } = parseMonth(r.moName);
    const unitPrice = (r.qty && r.qty !== 0) ? r.gross / r.qty : null;
    wsData.push([
      abbr, year, CONTRACT_NUM, CONTRACT_VERSION,
      r.mlbProductId, r.licenseeDesc, TERRITORY,
      r.retailerCode, r.retailerName, r.assetCode, r.attributeCode,
      unitPrice,                                                   // L: Retail/Wholesale Price
      r.qty,
      { f: `M${rowNum}*L${rowNum}` },                              // N: Gross Sales
      r.discounts, r.refunds,
      { f: `N${rowNum}-O${rowNum}-P${rowNum}` },                   // Q: Net Sales
      r.royaltyRate, 0,
      { f: `IFERROR(IF(Q${rowNum}<=0,IF((Q${rowNum}*(R${rowNum}/100))<((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum}),(Q${rowNum}*(R${rowNum}/100)),((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum})),IF(((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum})>(Q${rowNum}*(R${rowNum}/100)),((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum}),(Q${rowNum}*(R${rowNum}/100)))),0)` }, // T
      LANGUAGE, DIST_CHANNEL, CURRENCY, null, null,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // ── Apply $ currency format to L, N, Q, T (indices 11,13,16,19) ─────────
  const CURRENCY_COLS = new Set([11, 13, 16, 19]);
  {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let r = 1; r <= range.e.r; r++) {
      for (const c of CURRENCY_COLS) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) ws[addr] = { t: 'n', v: 0 };
        ws[addr].z = '$#,##0.00';
      }
    }
  }

  // ── Preserve green column highlighting from template ──────────────────────
  // Read styles from the template's MLB USA sheet (header row + first data row).
  // For each column that has a fill style, apply it to every data row we wrote.
  const tmplWs = templateWb && templateWb.Sheets['MLB USA'];
  if (tmplWs) {
    const colStyles = {}; // col index → style object

    // Check header row (r=0) and first data row (r=1) — whichever has a fill wins
    for (let checkRow = 1; checkRow >= 0; checkRow--) {
      for (let c = 0; c < headers.length; c++) {
        const addr = XLSX.utils.encode_cell({ r: checkRow, c });
        const cell = tmplWs[addr];
        if (cell && cell.s && cell.s.fill && cell.s.fill.fgColor) {
          colStyles[c] = JSON.parse(JSON.stringify(cell.s));
        }
      }
    }

    // Apply those styles to every data row (skip row 0 = our header)
    if (Object.keys(colStyles).length > 0) {
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let r = 1; r <= range.e.r; r++) {
        for (const [colStr, style] of Object.entries(colStyles)) {
          const c    = parseInt(colStr);
          const addr = XLSX.utils.encode_cell({ r, c });
          if (!ws[addr]) ws[addr] = { t: 'z', v: null };
          ws[addr].s = style;
        }
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'MLB USA');
  return wb;
}

// ─── Show Error Block ─────────────────────────────────────────────────────────
function showErrors(flagged, enriched, reportLabel) {
  const block     = document.getElementById('error-block');
  const container = document.getElementById('error-rows');
  block.querySelector('h3').textContent = `❌ Cannot Continue — ${flagged.length} Unmapped Row(s) in ${reportLabel}`;
  container.innerHTML = '';
  for (const idx of flagged) {
    const r   = enriched[idx];
    const div = document.createElement('div');
    div.className = 'error-row';
    div.innerHTML = `
      <div class="er-row">Row ${r.rowNum}</div>
      <div class="er-sku">${r.sku || '(no SKU)'}</div>
      <div class="er-issue">${r.flagReasons.join(' | ')}</div>
    `;
    container.appendChild(div);
  }
  block.classList.add('visible');
}

// ─── Add Download Button ──────────────────────────────────────────────────────
function addDownload(wb, filename, description) {
  const section = document.getElementById('downloads');
  section.classList.add('visible');
  const btn = document.createElement('div');
  btn.className = 'download-btn';
  btn.innerHTML = `<span class="dl-icon">⬇️</span><div><div>${filename}</div><div class="dl-desc">${description}</div></div>`;
  btn.onclick = () => XLSX.writeFile(wb, filename);
  section.appendChild(btn);
}

function addDownloadCSV(csv, filename, description) {
  const section = document.getElementById('downloads');
  section.classList.add('visible');
  const btn = document.createElement('div');
  btn.className = 'download-btn';
  btn.innerHTML = `<span class="dl-icon">⬇️</span><div><div>${filename}</div><div class="dl-desc">${description}</div></div>`;
  btn.onclick = () => {
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  section.appendChild(btn);
}

// ─── Main Run ─────────────────────────────────────────────────────────────────
async function runTool() {
  clearLog();
  document.getElementById('run-btn').disabled = true;

  if (currentMode === 'fanatics') {
    await runFanaticsMode();
  } else {
    await runOnlineMode();
  }

  document.getElementById('run-btn').disabled = false;
}

// ─── Fanatics Hard Goods Mode ─────────────────────────────────────────────────
async function runFanaticsMode() {
  log('═══════════════════════════════════════════════', 'dim');
  log('  Fanatics Hard Goods → Fanatics Submission', 'head');
  log('═══════════════════════════════════════════════', 'dim');
  log('');

  try {
    log('📂 Loading Shopify export...', 'info');
    const shopWb = XLSX.read(files.shopify.data, { type: 'array' });

    if (!shopWb.SheetNames.includes('HardGoods')) {
      log(`  ❌ "HardGoods" sheet not found in Shopify export`, 'error');
      log(`     Available sheets: ${shopWb.SheetNames.join(', ')}`, 'dim');
      return;
    }

    const ws = shopWb.Sheets['HardGoods'];
    log(`  ✓ HardGoods sheet found`, 'ok');

    log('🛍️  Parsing Hard Goods...', 'info');
    const { groups, skipped } = parseHardGoodsSheet(ws);
    log(`  ✓ ${groups.length} groups across ${new Set(groups.map(g => g.assetCode)).size} teams`, 'ok');

    if (skipped.length > 0) {
      log(`  ⚠  ${skipped.length} row(s) skipped:`, 'warn');
      for (const s of skipped) log(`     ${s}`, 'warn');
    }

    log('', 'info');
    log(`  ${'Asset'.padEnd(6)} | ${'Attr Code'.padEnd(12)} | ${'Qty'.padStart(5)} | Net Sales | Product`, 'dim');
    log(`  ${'─'.repeat(70)}`, 'dim');
    for (const g of groups) {
      const asset = String(g.assetCode).padEnd(6);
      const attr  = String(g.attrCode).padEnd(12);
      const qty   = String(g.qty).padStart(5);
      const net   = ('$' + g.netSales.toFixed(2)).padEnd(10);
      const prod  = g.productName.slice(0, 35);
      log(`  ${asset} | ${attr} | ${qty} | ${net} | ${prod}`, 'dim');
    }

    log('', 'info');
    log('📋 Writing Fanatics submission CSV...', 'info');
    const moLabel    = groups.length > 0 ? groups[0].mo : 'UNK';
    const { csv }    = writeFanaticsSubmission(groups);
    const outName    = `fanatics_hardgoods_submission_${moLabel}.csv`;
    log(`  ✓ ${outName}`, 'ok');
    addDownloadCSV(csv, outName, 'Fanatics Hard Goods submission — upload to BrandComply');

    log('', 'info');
    log('🎉 Done! Click the button above to download.', 'ok');

  } catch (err) {
    log('', 'info');
    log(`❌ Unexpected error: ${err.message}`, 'error');
    console.error(err);
  }
}

// ─── Retail Online Mode ───────────────────────────────────────────────────────
async function runOnlineMode() {
  log('════════════════════════════════════════════════════════════', 'dim');
  log('  Retail Online — Shopify → MLB Apparel Submission', 'head');
  log('════════════════════════════════════════════════════════════', 'dim');
  log('');

  try {
    log('📂 Loading reference data...', 'info');
    const refWb  = XLSX.read(files.reftables.data, { type: 'array' });
    const attrWb = XLSX.read(files.attrmap.data,   { type: 'array' });
    const tmplWb = XLSX.read(files.template.data,  { type: 'array', cellStyles: true });
    const shopWb = XLSX.read(files.shopify.data,   { type: 'array' });

    const { assetToTeam, teamToAsset } = loadReferenceTables(refWb);
    log(`  ✓ Loaded ${Object.keys(assetToTeam).length} team asset codes`, 'ok');

    const attrMapping = loadAttributeMapping(attrWb);
    log(`  ✓ Loaded ${Object.keys(attrMapping).length} product type mappings`, 'ok');

    log('', 'info');
    log('📊 Reading Shopify export...', 'info');

    let monthLabel   = 'UNK';
    let anyProcessed = false;

    for (const { sheetName, label } of SHEETS_TO_PROCESS) {
      if (!shopWb.SheetNames.includes(sheetName)) {
        log(`  ⚠  Sheet "${sheetName}" not found — skipping ${label}`, 'warn');
        log(`     Available: ${shopWb.SheetNames.join(', ')}`, 'dim');
        continue;
      }

      log('', 'info');
      log(`── ${label} (${sheetName}) ──────────────────────`, 'head');
      log(`🔄 Step 1: Enriching ${label} data...`, 'info');

      const ws = shopWb.Sheets[sheetName];
      const { enriched, flagged } = enrichSheet(ws, assetToTeam, teamToAsset, attrMapping);
      log(`  ✓ Processed ${enriched.length} rows`, 'ok');

      // Hard stop on unmapped rows
      if (flagged.length > 0) {
        log('', 'info');
        log(`  ❌ CANNOT CONTINUE — ${flagged.length} unmapped row(s)`, 'error');
        showErrors(flagged, enriched, label);
        document.getElementById('run-btn').disabled = false;
        return;
      }

      if (monthLabel === 'UNK') {
        const months = enriched.map(r => r.moName).filter(Boolean);
        if (months.length) monthLabel = String(months[0]).toUpperCase().slice(0, 3);
      }

      log(`💾 Writing BBSM working file...`, 'info');
      const bbsmWb   = writeBBSM(enriched, label);
      const bbsmName = `bbsm_${label.toLowerCase()}_${monthLabel}.xlsx`;
      log(`  ✓ ${bbsmName}`, 'ok');
      addDownload(bbsmWb, bbsmName, `BBSM enriched working file — ${label}`);

      log(`📋 Step 2: Filling MLB submission template...`, 'info');
      const mlbWb   = writeMLBSubmission(enriched, null, tmplWb, assetToTeam);
      const mlbName = `mlb_submission_${label.toLowerCase()}_${monthLabel}.xlsx`;
      log(`  ✓ ${mlbName}`, 'ok');
      addDownload(mlbWb, mlbName, `MLB submission file — ${label}`);

      // Debug: grouped summary
      const grouped = groupRows(enriched, assetToTeam);
      log(``, 'info');
      log(`  📊 Grouped rows (${grouped.length} total):`, 'dim');
      log(`  ${'Asset'.padEnd(6)} | ${'Attr Code'.padEnd(12)} | ${'Qty'.padStart(6)} | Gross`, 'dim');
      log(`  ${'─'.repeat(55)}`, 'dim');
      for (const g of grouped) {
        const asset = String(g.assetCode || 'MLB').padEnd(6);
        const attr  = String(g.attributeCode || '').padEnd(12);
        const qty   = String(g.qty).padStart(6);
        const gross = '$' + g.gross.toFixed(2);
        log(`  ${asset} | ${attr} | ${qty} | ${gross}`, 'dim');
      }

      log(``, 'info');
      log(`✅ ${label} complete!`, 'ok');
      anyProcessed = true;
    }

    if (!anyProcessed) {
      log('', 'info');
      log('⚠  No matching sheets found. Make sure your Shopify export', 'warn');
      log('   has a sheet named "MLB Retail-Online".', 'warn');
    } else {
      log('', 'info');
      log('🎉 All reports complete! Click the buttons above to download.', 'ok');
    }

  } catch (err) {
    log('', 'info');
    log(`❌ Unexpected error: ${err.message}`, 'error');
    console.error(err);
  }
}

// ─── On page load ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setMode('online');      // default mode, also hides/shows correct slots
  loadPersistedFiles();   // restore cached reference files
});
