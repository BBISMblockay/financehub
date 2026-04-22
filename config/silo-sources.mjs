// config/silo-sources.mjs

export const INVENTORY_SOURCES = [
  {
    location_tag: "online",
    location_name: "Online",
    shop_domain: "baseballism.com",
    gid: 0,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=0",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1e6ONBk-qlMFGSzI6xLdmfzOyvBaGk99T8stZ_mPpZX0/export?format=csv&gid=1924149688",
  },
  {
    location_tag: "atlanta",
    location_name: "Atlanta",
    shop_domain: null,
    gid: 186382360,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=186382360",
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
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/12dvRZTaDwLtvT48g17tr93QYsjOb1PspZFW8m9fnk9E/export?format=csv&gid=1271169490",
  },
  {
    location_tag: "field_of_dreams",
    location_name: "Field of Dreams",
    shop_domain: null,
    gid: 1737418391,
    inventory_csv_url:
      "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1737418391",
    sales_daily_csv_url:
      "https://docs.google.com/spreadsheets/d/1yJ0tNyP_1XL5t77sSaRO48r6B9C5qnXvZxS0B7dBAFo/export?format=csv&gid=404045375",
  },

 

/**
 * Runtime validation.
 * Placeholders are allowed, but skipped until wired.
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
    if (!src.inventory_csv_url) {
      throw new Error(`Missing inventory_csv_url for: ${src.location_tag}`);
    }
    if (!src.sales_daily_csv_url) {
      throw new Error(`Missing sales_daily_csv_url for: ${src.location_tag}`);
    }
    seen.add(src.location_tag);
  }

  return true;
}
