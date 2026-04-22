export const INVENTORY_SOURCES = [
  {
    location_tag: "online",
    location_name: "Online",
    shop_domain: "baseballism.com",
    gid: 0,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=0",
    sales_csv_url: "https://docs.google.com/spreadsheets/u/1/d/1e6ONBk-qlMFGSzI6xLdmfzOyvBaGk99T8stZ_mPpZX0/htmlview#gid=1924149688"
  },
  {
    location_tag: "atlanta",
    location_name: "Atlanta",
    shop_domain: null,
    gid: 186382360,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=186382360",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTrGtyPQZ9UZY0xn1vk49Aapc5PVpWTMfCctjyNH8K3rLrjUifqaxqZPC5vpA91FTdFm_yNdNhaThxY/pub?gid=1350148138&single=true&output=csv"
  },
  {
    location_tag: "scottsdale",
    location_name: "Scottsdale",
    shop_domain: null,
    gid: 1686608564,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1686608564",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRisfYgm-JqLdAW4GrAl_K3dNPJxadE5VaQ7Fzju8vaWv9zEyXGJk6d5ZfM6owfhvHHz_Q-B36FuUqo/pub?gid=1328363473&single=true&output=csv"
  },
  {
    location_tag: "st_louis",
    location_name: "St. Louis",
    shop_domain: null,
    gid: 702923083,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=702923083",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSvg4es9sqAsE6jzjea7Fw7vye8IoKH_UK8JJzGg8GXqtZFsvE2qBbvVp0ziSWibh6F1mB6QOy4Vr7h/pub?gid=1410428296&single=true&output=csv"
  },
  {
    location_tag: "mission_viejo",
    location_name: "Mission Viejo",
    shop_domain: null,
    gid: 948572027,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=948572027",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSrVrtbatItRNJttp-6kFQE1m7XEWbPpRo6zIAqS3GBmNMqtoHuUemQK8-TR8Ya3QIMRVpJ-4ZvpUtu/pub?gid=589960408&single=true&output=csv"
  },
  {
    location_tag: "texas",
    location_name: "Texas",
    shop_domain: null,
    gid: 335482043,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=335482043",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSN19QBHslssiO4QpVXHxqfScuKqc9Rd0gzwuOGhIMnDa9H2HxlL0QmTDMHbbEfsaOVUzMhqkUj7uUr/pub?gid=679482519&single=true&output=csv"
  },
  {
    location_tag: "field_of_dreams",
    location_name: "Field of Dreams",
    shop_domain: null,
    gid: 1737418391,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1737418391",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNcbG_a-H8vmNF7Qm3S_n5a3MTuMZvsicODjImal2jylO74gB--3Mpgv9cCPG37WG4HFvshUrIfDdM/pub?gid=343232419&single=true&output=csv"
  },
  {
    location_tag: "cooperstown",
    location_name: "Cooperstown",
    shop_domain: null,
    gid: 1924417187,
    csv_url: "https://docs.google.com/spreadsheets/d/1TsOL-rynXG7DlfVHU2GAfN0UtYE3OVebpaB-N--Irb0/export?format=csv&gid=1924417187",
    sales_csv_url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTZDCPonNizaXhEklZp8ovhc_Iti725FpgZzyeu_rovAceUq9obq_AKvo0a7u-5SotcJh4xi-FC3FAv/pub?gid=965359182&single=true&output=csv"
  }
];

/**
 * Optional helper if you ever want to validate unique location tags at runtime.
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
    if (!src.csv_url) {
      throw new Error(`Missing inventory csv_url for: ${src.location_tag}`);
    }
    if (!src.sales_csv_url) {
      throw new Error(`Missing sales_csv_url for: ${src.location_tag}`);
    }
    seen.add(src.location_tag);
  }

  return true;
}
