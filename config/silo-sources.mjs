// config/silo-sources.mjs

function googleCsvExportUrl(sheetId, gid = 0) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

export const INVENTORY_SOURCES = [
  {
    location_tag: "online",
    location_name: "Online",
    shop_domain: "baseballism.com",
    gid: 0,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=0",

    // Old full-history BI/backfill link. Do not use for normal nightly sync.
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1e6ONBk-qlMFGSzI6xLdmfzOyvBaGk99T8stZ_mPpZX0/export?format=csv&gid=1924149688",

    // New 7-day Silo sync link.
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1MHpMdXi2im3iRzcMcJ1j5QU-7nwz7Zgo-71sueGS0i0/export?format=csv&gid=0",
  },
  {
    location_tag: "atlanta",
    location_name: "Atlanta",
    shop_domain: null,
    gid: 186382360,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=186382360",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1OV2vtJ6AHvE7qfw_8VmsgUermDhzjsK_Ha35U-SK_so/export?format=csv&gid=806693206",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1OV2vtJ6AHvE7qfw_8VmsgUermDhzjsK_Ha35U-SK_so/export?format=csv&gid=806693206",
  },
  {
    location_tag: "scottsdale",
    location_name: "Scottsdale",
    shop_domain: null,
    gid: 1686608564,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1686608564",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1Z4kgtyQv7MnEPnyS41zeCKhs4jlWNNWKZ7WxzLhNESo/export?format=csv&gid=1308507463",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1Z4kgtyQv7MnEPnyS41zeCKhs4jlWNNWKZ7WxzLhNESo/export?format=csv&gid=1308507463",
  },
  {
    location_tag: "st_louis",
    location_name: "St. Louis",
    shop_domain: null,
    gid: 702923083,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=702923083",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1aLW8A8QrV07K8KQAo3pR2-ZBnbxGQRxt5OgOMJmeXBI/export?format=csv&gid=1857460869",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1aLW8A8QrV07K8KQAo3pR2-ZBnbxGQRxt5OgOMJmeXBI/export?format=csv&gid=1857460869",
  },
  {
    location_tag: "mission_viejo",
    location_name: "Mission Viejo",
    shop_domain: null,
    gid: 948572027,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=948572027",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1rIolFKa5CoGyE4oyGCKqOEW43-eo92EyMFUMGAHpqZI/export?format=csv&gid=1048230983",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1rIolFKa5CoGyE4oyGCKqOEW43-eo92EyMFUMGAHpqZI/export?format=csv&gid=1048230983",
  },
  {
    location_tag: "texas",
    location_name: "Texas",
    shop_domain: null,
    gid: 335482043,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=335482043",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/17RU6dwFcUe_Ek-kttLaCGHRJHPUBwo0Y1p8y6thmCz0/export?format=csv&gid=850240535",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/17RU6dwFcUe_Ek-kttLaCGHRJHPUBwo0Y1p8y6thmCz0/export?format=csv&gid=850240535",
  },
  {
    location_tag: "cooperstown",
    location_name: "Cooperstown",
    shop_domain: null,
    gid: 1924417187,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1924417187",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/12dvRZTaDwLtvT48g17tr93QYsjOb1PspZFW8m9fnk9E/export?format=csv&gid=1271169490",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/12dvRZTaDwLtvT48g17tr93QYsjOb1PspZFW8m9fnk9E/export?format=csv&gid=1271169490",
  },
  {
    location_tag: "lakepoint",
    location_name: "Lakepoint",
    shop_domain: null,
    gid: 2040225568,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=2040225568",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1pIOhsDP42GRdL9rvGMB9KHdBW1ZDNIV_MCQ9VJa1bdk/export?format=csv&gid=942246931",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1pIOhsDP42GRdL9rvGMB9KHdBW1ZDNIV_MCQ9VJa1bdk/export?format=csv&gid=942246931",
  },
  {
    location_tag: "ontario",
    location_name: "Ontario",
    shop_domain: null,
    gid: 863008870,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=863008870",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1MY8Mysg3i3FsSMyfzOTNqxxSLuSjs8VccHg4HZ9OToU/export?format=csv&gid=213281218",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1MY8Mysg3i3FsSMyfzOTNqxxSLuSjs8VccHg4HZ9OToU/export?format=csv&gid=213281218",
  },
  {
    location_tag: "field_of_dreams",
    location_name: "Field of Dreams",
    shop_domain: null,
    gid: 1737418391,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1737418391",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1yJ0tNyP_1XL5t77sSaRO48r6B9C5qnXvZxS0B7dBAFo/export?format=csv&gid=404045375",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1yJ0tNyP_1XL5t77sSaRO48r6B9C5qnXvZxS0B7dBAFo/export?format=csv&gid=404045375",
  },

  // Sales-only / historical / seasonal / closed / wholesale sources.
  // These intentionally have inventory_csv_url: null so inventory sync can skip them.
  // Current daily URLs are still full-history until each location gets a duplicated 7-day report.

  {
    location_tag: "chesterfield",
    location_name: "Chesterfield",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/15hF7xymuryl6fOEWo4eas09LP2OtVJtfl4INeb_0pDU/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/15hF7xymuryl6fOEWo4eas09LP2OtVJtfl4INeb_0pDU/export?format=csv&gid=0",
    source_note: "No inventory to report - shares Shopify with St. Louis",
  },
  {
    location_tag: "chicago",
    location_name: "Chicago",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/135pbyKIDJUYnv9PfJ9oyoXZLqVq-06jPIxi83HUlciw/export?format=csv&gid=1071346335",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/135pbyKIDJUYnv9PfJ9oyoXZLqVq-06jPIxi83HUlciw/export?format=csv&gid=1071346335",
    source_note: "No inventory to report - store is closed - historical sales only",
  },
  {
    location_tag: "college_world_series",
    location_name: "College World Series",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1NFyVDhdFXIYMavh0aS6raq5EI37Qj7CtQ-FUejsEJcM/export?format=csv&gid=534471104",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1NFyVDhdFXIYMavh0aS6raq5EI37Qj7CtQ-FUejsEJcM/export?format=csv&gid=534471104",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "grand_park",
    location_name: "Grand Park",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/161TJdFjZVQtBdGSXgQ4Ob4fWQVbRDLwpymrrhH0xHFw/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/161TJdFjZVQtBdGSXgQ4Ob4fWQVbRDLwpymrrhH0xHFw/export?format=csv&gid=0",
    source_note: "No inventory - store closed - historical sales only",
  },
  {
    location_tag: "hohokam",
    location_name: "Hohokam",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/12Y03AnPP2k_lniJj01mW9gfNEhfEZeV0qwjzdH0VHBw/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/12Y03AnPP2k_lniJj01mW9gfNEhfEZeV0qwjzdH0VHBw/export?format=csv&gid=0",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "irvine",
    location_name: "Irvine",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1ifR6h5XoZhKNpC7lPJfxEcqTKM3_2IrhulipcDYegIk/export?format=csv&gid=1177326560",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1ifR6h5XoZhKNpC7lPJfxEcqTKM3_2IrhulipcDYegIk/export?format=csv&gid=1177326560",
    source_note: "Irvine closed - historical sales only",
  },
  {
    location_tag: "peoria",
    location_name: "Peoria",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1l2vM7DIq9Ov4dE58sUzvzEZYIKqPdjbQcxMVho5wAQQ/export?format=csv&gid=739086750",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1l2vM7DIq9Ov4dE58sUzvzEZYIKqPdjbQcxMVho5wAQQ/export?format=csv&gid=739086750",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "sacramento",
    location_name: "Sacramento",
    shop_domain: null,
    gid: 1025836195,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1025836195",
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1YEW8QMXhXdh18KOtaiqvnQj_fre-Ju-ifNWLgodb1-E/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1YEW8QMXhXdh18KOtaiqvnQj_fre-Ju-ifNWLgodb1-E/export?format=csv&gid=0",
  },
  {
    location_tag: "west_palm",
    location_name: "West Palm",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1EIAhg0T0bYhAas-Y2DWAK05yXwGB6DzKtFshqEmjNQo/export?format=csv&gid=462681770",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1EIAhg0T0bYhAas-Y2DWAK05yXwGB6DzKtFshqEmjNQo/export?format=csv&gid=462681770",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "goodyear",
    location_name: "Goodyear",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1E-XbWDKzegG3Z9hLOLS3CmLkMDuvPuIL9Hv_rvFuzdc/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1E-XbWDKzegG3Z9hLOLS3CmLkMDuvPuIL9Hv_rvFuzdc/export?format=csv&gid=0",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "wholesale-b2b",
    location_name: "Wholesale - B2B",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1ssDq8woW4Nj0xg4w3ECU_4Pij9pQ5TDrTvRAgjaqN2Q/export?format=csv&gid=1922617606",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1ssDq8woW4Nj0xg4w3ECU_4Pij9pQ5TDrTvRAgjaqN2Q/export?format=csv&gid=1922617606",
    source_note: "No inventory to report on wholesale - B2B",
  },
  {
    location_tag: "wholesale_dsg",
    location_name: "Wholesale - DSG",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1OTuZyR36sFc2LENbKzZS7mDfyQpfpE897jM4XXYkqyU/export?format=csv&gid=62451732",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1OTuZyR36sFc2LENbKzZS7mDfyQpfpE897jM4XXYkqyU/export?format=csv&gid=62451732",
    source_note: "No inventory to report on wholesale - DSG",
  },
  {
    location_tag: "wholesale_mlb",
    location_name: "Wholesale - MLB",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1Pyt7zvP23T51Sr7X4AKky6q8gxjoKhmlHw8sDnqtlqg/export?format=csv&gid=53482340",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1Pyt7zvP23T51Sr7X4AKky6q8gxjoKhmlHw8sDnqtlqg/export?format=csv&gid=53482340",
    source_note: "No inventory to report on wholesale - MLB",
  },
  {
    location_tag: "wholesale-faire",
    location_name: "Wholesale - Faire",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1LnnSOzbJ3LBsc5LStU05L1CgLFxheBj5pwHJmM2DEaE/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1LnnSOzbJ3LBsc5LStU05L1CgLFxheBj5pwHJmM2DEaE/export?format=csv&gid=0",
    source_note: "No inventory to report on wholesale - Faire",
  },
  {
    location_tag: "salt_river",
    location_name: "Salt River",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1N6h8beO9XY7fslSQqevmPFBpd00TXPPL2X5ZddmN9GI/export?format=csv&gid=2109690736",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1N6h8beO9XY7fslSQqevmPFBpd00TXPPL2X5ZddmN9GI/export?format=csv&gid=2109690736",
    source_note: "No inventory - pop-up / seasonal sales",
  },
  {
    location_tag: "allen",
    location_name: "Allen",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/1vaD1FLZZV4nQdjvWaHHKzjRLSMu7Q76Hhts6Wi5lW40/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1vaD1FLZZV4nQdjvWaHHKzjRLSMu7Q76Hhts6Wi5lW40/export?format=csv&gid=0",
    source_note: "No inventory to report - shares Shopify with Texas",
  },
  {
    location_tag: "frisco",
    location_name: "Frisco",
    shop_domain: null,
    gid: null,
    inventory_csv_url: null,
    sales_backfill_csv_url:
      "https://docs.google.com/spreadsheets/d/12hsdMcHsrk0xGMZn6V6Uyv1PFShVjCx7PiGofs5xH2c/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/12hsdMcHsrk0xGMZn6V6Uyv1PFShVjCx7PiGofs5xH2c/export?format=csv&gid=0",
    source_note: "No inventory to report - shares Shopify with Texas / historical sales",
  },
];

/**
 * Sources with inventory enabled.
 * Use this in the inventory sync loop.
 */
export function getInventorySources(sources = INVENTORY_SOURCES) {
  return sources.filter((src) => !!src.inventory_csv_url);
}

/**
 * Sources with daily/recent sales enabled.
 * Normal nightly sync uses sales_daily_csv_url.
 */
export function getSalesSources(sources = INVENTORY_SOURCES) {
  return sources.filter((src) => !!src.sales_daily_csv_url);
}

/**
 * Sources with backfill sales enabled.
 * Manual backfill mode uses sales_backfill_csv_url.
 */
export function getBackfillSalesSources(sources = INVENTORY_SOURCES) {
  return sources.filter((src) => !!src.sales_backfill_csv_url);
}

/**
 * Runtime validation.
 * Inventory is optional because several locations are closed, seasonal,
 * wholesale-only, or historical-sales-only.
 */
export function validateSources(sources = INVENTORY_SOURCES) {
  const seen = new Set();

  for (const src of sources) {
    if (!src.location_tag) {
      throw new Error(`Missing location_tag for source: ${JSON.stringify(src)}`);
    }

    if (seen.has(src.location_tag)) {
      throw new Error(`Duplicate location_tag found: ${src.location_tag}`);
    }

    if (!src.inventory_csv_url && !src.sales_daily_csv_url && !src.sales_backfill_csv_url) {
      throw new Error(
        `Missing inventory_csv_url, sales_daily_csv_url, and sales_backfill_csv_url for: ${src.location_tag}`
      );
    }

    seen.add(src.location_tag);
  }

  return true;
}
