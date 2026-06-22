// ─── State ────────────────────────────────────────────────────────────────────
const files = { shopify: null };
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
  'key chain':     { attrCode: 10061487, product: 'Hard Goods > Gifts/Novelties/Misc. > Key Chains' },
  "men's wallet":  { attrCode: 10062362, product: 'Hard Goods > Personal/Fashion Accessories > Wallets/Purses > Adult' },
  'poster':        { attrCode: 10062330, product: 'Hard Goods > Publishing/Posters/Art > Posters' },
};

// ─── Store → Fanatics Channel ─────────────────────────────────────────────────
const CHANNEL_ONLINE    = 'Licensee Direct > Licensee Direct to Consumer > Online > Licensee owned or affiliated website';
const CHANNEL_BRICKMORTAR = 'Licensee Direct > Licensee Direct to Consumer > Brick & Mortar';

// ─── Raw Export Filters ───────────────────────────────────────────────────────
// Used when the tool receives a raw Shopify Export sheet instead of pre-split sheets
const WHOLESALE_STORES = ['Wholesale - MLB', 'Wholesale - Faire'];

// ─── Wholesale MLB Constants ──────────────────────────────────────────────────
// Applied to all Wholesale - MLB rows in the MLB submission
const WHOLESALE_ROYALTY_RATE = 21;
const WHOLESALE_DIST_CHANNEL = 'INSTLEAG';

// ─── MiLB Constants ───────────────────────────────────────────────────────────
const MILB_ROYALTY_RATE  = 12;  // TODO: confirm rate with MiLB contract
const MILB_DIST_CHANNEL  = 'AFFIL';
const MILB_TERRITORY     = 'USA';
const MILB_RETAILER_CODE = 5431;   // fallback only
const MILB_RETAILER_NAME = 'Baseballism'; // fallback only

// Maps trademark code → { name, code } per the DBH retailer list
const MILB_RETAILER_MAP = {
  "AKRR":   { name: "[MiLB] AKRON RUBBERDUCKS",              code: 1890 },
  "ALBI":   { name: "[MiLB] ALBUQUERQUE ISOTOPES",           code: 1891 },
  "ALTC":   { name: "[MiLB] ALTOONA CURVE",                  code: 1892 },
  "ASP":    { name: "[MiLB] AMARILLO SOD POODLES",           code: 4853 },
  "ARKT":   { name: "[MiLB] ARKANSAS TRAVELERS",             code: 1893 },
  "ASHT":   { name: "[MiLB] ASHEVILLE TOURISTS",             code: 1894 },
  "AGJ":    { name: "[MiLB] AUGUSTA GREENJACKETS",           code: 1896 },
  "BELOSC": { name: "[MiLB] BELOIT SKY CARP",                code: 5612 },
  "BINR":   { name: "[MiLB] BINGHAMTON RUMBLE PONIES",       code: 3868 },
  "BILS":   { name: "[MiLB] BILOXI SHUCKERS",                code: 1901 },
  "BHMB":   { name: "[MiLB] BIRMINGHAM BARONS",              code: 1903 },
  "BOWH":   { name: "[MiLB] BOWLING GREEN HOT RODS",         code: 1907 },
  "BRAM":   { name: "[MiLB] BRADENTON MARAUDERS",            code: 1908 },
  "BKCL":   { name: "[MiLB] BROOKLYN CYCLONES",              code: 1911 },
  "BUFF":   { name: "[MiLB] BUFFALO BISONS",                 code: 1912 },
  "CRR":    { name: "[MiLB] CEDAR RAPIDS KERNELS",           code: 1916 },
  "CRD":    { name: "[MiLB] CHARLESTON RIVERDOGS",           code: 1917 },
  "CHAR":   { name: "[MiLB] CHARLOTTE KNIGHTS",              code: 1918 },
  "CHAT":   { name: "[MiLB] CHATTANOOGA LOOKOUTS",           code: 1920 },
  "CLWTR":  { name: "[MiLB] CLEARWATER THRESHERS",           code: 1921 },
  "COLF":   { name: "[MiLB] COLUMBIA FIREFLIES",             code: 1924 },
  "COLCL":  { name: "[MiLB] COLUMBUS CLIPPERS",              code: 1925 },
  "COLCLI": { name: "[MiLB] COLUMBUS CLINGSTONES",           code: 5732 },
  "CCH":    { name: "[MiLB] CORPUS CHRISTI HOOKS",           code: 1927 },
  "DAYD":   { name: "[MiLB] DAYTON DRAGONS",                 code: 1929 },
  "DAYT":   { name: "[MiLB] DAYTONA TORTUGAS",               code: 1930 },
  "DELM":   { name: "[MiLB] DELMARVA SHOREBIRDS",            code: 1931 },
  "DOWW":   { name: "[MiLB] DOWN EAST WOOD DUCKS",           code: 3870 },
  "DBJ":    { name: "[MiLB] DUNEDIN BLUE JAYS",              code: 1932 },
  "DURB":   { name: "[MiLB] DURHAM BULLS",                   code: 1933 },
  "ELPC":   { name: "[MiLB] EL PASO CHIHUAHUAS",             code: 1934 },
  "ERIE":   { name: "[MiLB] ERIE SEAWOLVES",                 code: 1936 },
  "EUGN":   { name: "[MiLB] EUGENE EMERALDS",                code: 1937 },
  "EVER":   { name: "[MiLB] EVERETT AQUASOX",                code: 1938 },
  "FYWD":   { name: "[MiLB] FAYETTEVILLE WOODPECKERS",       code: 4854 },
  "FTMYM":  { name: "[MiLB] FORT MYERS MIGHTY MUSSELS",      code: 5209 },
  "FORT":   { name: "[MiLB] FORT WAYNE TINCAPS",             code: 1940 },
  "FREK":   { name: "[MiLB] FREDERICK KEYS",                 code: 6623 },
  "FRDN":   { name: "[MiLB] FREDERICKSBURG NATIONALS",       code: 5203 },
  "FRES":   { name: "[MiLB] FRESNO GRIZZLIES",               code: 1942 },
  "FRIR":   { name: "[MiLB] FRISCO ROUGHRIDERS",             code: 1943 },
  "GREL":   { name: "[MiLB] GREAT LAKES LOONS",              code: 1946 },
  "GRGR":   { name: "[MiLB] GREENSBORO GRASSHOPPERS",        code: 2834 },
  "GRED":   { name: "[MiLB] GREENVILLE DRIVE",               code: 1948 },
  "GWIS":   { name: "[MiLB] GWINNETT STRIPERS",              code: 5870 },
  "HBS":    { name: "[MiLB] HARRISBURG SENATORS",            code: 1951 },
  "HARTY":  { name: "[MiLB] HARTFORD YARD GOATS",            code: 1952 },
  "HICC":   { name: "[MiLB] HICKORY CRAWDADS",               code: 1954 },
  "HCHOW":  { name: "[MiLB] HILL CITY HOWLERS",              code: 6634 },
  "HILH":   { name: "[MiLB] HILLSBORO HOPS",                 code: 1956 },
  "HCS":    { name: "[MiLB] HUB CITY SPARTANBURGS",          code: 5734 },
  "HVR":    { name: "[MiLB] HUDSON VALLEY RENEGADES",        code: 1957 },
  "IND":    { name: "[MiLB] INDIANAPOLIS INDIANS",           code: 1959 },
  "INLS":   { name: "[MiLB] INLAND EMPIRE 66ERS",            code: 1960 },
  "IOWA":   { name: "[MiLB] IOWA CUBS",                      code: 1961 },
  "JACJ":   { name: "[MiLB] JACKSONVILLE JUMBO SHRIMP",      code: 3872 },
  "JSBC":   { name: "[MiLB] JERSEY SHORE BLUECLAWS",         code: 5438 },
  "JUPI":   { name: "[MiLB] JUPITER HAMMERHEADS",            code: 1965 },
  "KANCB":  { name: "[MiLB] KANNAPOLIS CANNON BALLERS",      code: 5204 },
  "KNOXSM": { name: "[MiLB] KNOXVILLE SMOKIES",              code: 5736 },
  "LAKC":   { name: "[MiLB] LAKE COUNTY CAPTAINS",           code: 1969 },
  "LES":    { name: "[MiLB] LAKE ELSINORE STORM",            code: 1970 },
  "LLT":    { name: "[MiLB] LAKELAND FLYING TIGERS",         code: 1971 },
  "LANS":   { name: "[MiLB] LANSING LUGNUTS",                code: 1974 },
  "LVA":    { name: "[MiLB] LAS VEGAS AVIATORS",             code: 4855 },
  "LEHI":   { name: "[MiLB] LEHIGH VALLEY IRONPIGS",         code: 1976 },
  "LOUB":   { name: "[MiLB] LOUISVILLE BATS",                code: 1978 },
  "MEMP":   { name: "[MiLB] MEMPHIS REDBIRDS",               code: 1982 },
  "MLRH":   { name: "[MiLB] MIDLAND ROCKHOUNDS",             code: 1983 },
  "MNTB":   { name: "[MiLB] MONTGOMERY BISCUITS",            code: 1988 },
  "MYRT":   { name: "[MiLB] MYRTLE BEACH PELICANS",          code: 1989 },
  "NASH":   { name: "[MiLB] NASHVILLE SOUNDS",               code: 1990 },
  "NHFC":   { name: "[MiLB] NEW HAMPSHIRE FISHER CATS",      code: 1991 },
  "NORT":   { name: "[MiLB] NORFOLK TIDES",                  code: 1993 },
  "NORN":   { name: "[MiLB] NORTHWEST ARKANSAS NATURALS",    code: 1994 },
  "OKCC":   { name: "[MiLB] OKLAHOMA CITY COMETS",           code: 5733 },
  "OMAS":   { name: "[MiLB] OMAHA STORM CHASERS",            code: 1997 },
  "ONTTB":  { name: "[MiLB] ONTARIO TOWER BUZZERS",          code: 6621 },
  "PALC":   { name: "[MiLB] PALM BEACH CARDINALS",           code: 1999 },
  "PENB":   { name: "[MiLB] PENSACOLA BLUE WAHOOS",          code: 2001 },
  "PEDC":   { name: "[MiLB] PEORIA CHIEFS",                  code: 2002 },
  "PSD":    { name: "[MiLB] PORTLAND SEA DOGS",              code: 2003 },
  "QCRB":   { name: "[MiLB] QUAD CITIES RIVER BANDITS",      code: 2007 },
  "RANQ":   { name: "[MiLB] RANCHO CUCAMONGA QUAKES",        code: 2008 },
  "RDNG":   { name: "[MiLB] READING FIGHTIN PHILS",          code: 3874 },
  "RENA":   { name: "[MiLB] RENO ACES",                      code: 2010 },
  "RICF":   { name: "[MiLB] RICHMOND FLYING SQUIRRELS",      code: 2011 },
  "RRW":    { name: "[MiLB] ROCHESTER RED WINGS",            code: 2012 },
  "RCTP":   { name: "[MiLB] ROCKET CITY TRASH PANDAS",       code: 4856 },
  "ROMEE":  { name: "[MiLB] ROME EMPORERS",                  code: 5730 },
  "RRE":    { name: "[MiLB] ROUND ROCK EXPRESS",             code: 2014 },
  "SACR":   { name: "[MiLB] SACRAMENTO RIVER CATS",          code: 2015 },
  "SALMRY": { name: "[MiLB] SALEM RIDGE YAKS",               code: 6620 },
  "SALB":   { name: "[MiLB] SALT LAKE BEES",                 code: 2018 },
  "SAM":    { name: "[MiLB] SAN ANTONIO MISSIONS",           code: 2019 },
  "SJG":    { name: "[MiLB] SAN JOSE GIANTS",                code: 2020 },
  "SCRR":   { name: "[MiLB] SCRANTON WILKES-BARRE RAILRIDERS", code: 2022 },
  "SOMSPT": { name: "[MiLB] SOMERSET PATRIOTS",              code: 5434 },
  "SOUC":   { name: "[MiLB] SOUTH BEND CUBS",                code: 2023 },
  "SPIN":   { name: "[MiLB] SPOKANE INDIANS",                code: 2024 },
  "SPIC":   { name: "[MiLB] SPRINGFIELD CARDINALS",          code: 2025 },
  "SAIM":   { name: "[MiLB] ST. LUCIE METS",                 code: 2026 },
  "SPS":    { name: "[MiLB] ST. PAUL SAINTS",                code: 5436 },
  "STOP":   { name: "[MiLB] STOCKTON PORTS",                 code: 2029 },
  "SUGLSC": { name: "[MiLB] SUGAR LAND SPACE COWBOYS",       code: 5613 },
  "SYRCM":  { name: "[MiLB] SYRACUSE METS",                  code: 4857 },
  "TACO":   { name: "[MiLB] TACOMA RAINIERS",                code: 2031 },
  "TAMT":   { name: "[MiLB] TAMPA TARPONS",                  code: 5184 },
  "TENS":   { name: "[MiLB] TENNESSEE SMOKIES",              code: 2033 },
  "TMH":    { name: "[MiLB] TOLEDO MUD HENS",                code: 2034 },
  "TCDD":   { name: "[MiLB] TRI-CITY DUST DEVILS",           code: 2036 },
  "TLSA":   { name: "[MiLB] TULSA DRILLERS",                 code: 2038 },
  "VANC":   { name: "[MiLB] VANCOUVER CANADIANS",            code: 2039 },
  "VISR":   { name: "[MiLB] VISALIA RAWHIDE",                code: 2041 },
  "WMWC":   { name: "[MiLB] WEST MICHIGAN WHITECAPS",        code: 2042 },
  "CHSPBSX":{ name: "[MiLB] CHESAPEAKE BAYSOX",              code: 5731 },
  "WTAWS":  { name: "[MILB] WICHITA WIND SURGE",             code: 5206 },
  "WILB":   { name: "[MiLB] WILMINGTON BLUE ROCKS",          code: 2046 },
  "WLWRB":  { name: "[MiLB] WILSON WARBIRDS",                code: 5735 },
  "WIND":   { name: "[MiLB] WINSTON-SALEM DASH",             code: 2047 },
  "WISC":   { name: "[MiLB] WISCONSIN TIMBER RATTLERS",      code: 2048 },
  "WORCRS": { name: "[MiLB] WORCESTER RED SOX",              code: 5729 },
};

// Maps each team asset code → MLB club retailer ID + full legal club name
// Source: Reference Tables MLB.xlsx › License Retailer tab
const WHOLESALE_RETAILER_MAP = {
  'ANA':  { code: 1031, name: 'ANAHEIM ANGELS BASEBALL CLUB' },
  'ARI':  { code: 1048, name: 'ARIZONA DIAMONDBACKS BASEBALL CLUB' },
  'ATL':  { code: 1059, name: 'ATLANTA BRAVES BASEBALL CLUB' },
  'BAL':  { code: 1066, name: 'BALTIMORE ORIOLES BASEBALL CLUB' },
  'BOS':  { code: 1111, name: 'BOSTON RED SOX BASEBALL CLUB' },
  'CHI':  { code: 1149, name: 'CHICAGO CUBS BASEBALL CLUB' },
  'CWS':  { code: 1152, name: 'CHICAGO WHITE SOX BASEBALL CLUB' },
  'CIN':  { code: 1156, name: 'CINCINNATI REDS BASEBALL CLUB' },
  'COL':  { code: 1176, name: 'COLORADO ROCKIES BASEBALL CLUB' },
  'DET':  { code: 1210, name: 'DETROIT TIGERS BASEBALL CLUB' },
  'HOU':  { code: 1412, name: 'HOUSTON ASTROS BASEBALL CLUB' },
  'KC':   { code: 1450, name: 'KANSAS CITY ROYALS BASEBALL CLUB' },
  'LA':   { code: 1491, name: 'LOS ANGELES DODGERS BASEBALL CLUB/GUGGENHEIM BASEBALL MANAGEMENT' },
  'MIA':  { code: 1527, name: 'MIAMI MARLINS BASEBALL CLUB' },
  'MIL':  { code: 1536, name: 'MILWAUKEE BREWERS BASEBALL CLUB' },
  'MIN':  { code: 1537, name: 'MINNESOTA TWINS BASEBALL CLUB' },
  'NY':   { code: 1559, name: 'NEW YORK METS BASEBALL CLUB' },
  'NYY':  { code: 1560, name: 'NEW YORK YANKEES BASEBALL CLUB' },
  'ATH':  { code: 1577, name: 'ATHLETICS BASEBALL CLUB' },
  'PHI':  { code: 1609, name: 'PHILADELPHIA PHILLIES BASEBALL CLUB' },
  'PIT':  { code: 1615, name: 'PITTSBURGH PIRATES BASEBALL CLUB' },
  'SD':   { code: 1670, name: 'SAN DIEGO PADRES BASEBALL CLUB' },
  'SF':   { code: 1672, name: 'SAN FRANCISCO GIANTS BASEBALL CLUB' },
  'SEA':  { code: 1684, name: 'SEATTLE MARINERS BASEBALL CLUB' },
  'STL':  { code: 1767, name: 'ST LOUIS CARDINALS BASEBALL CLUB' },
  'TB':   { code: 1791, name: 'TAMPA BAY RAYS BASEBALL CLUB' },
  'TEX':  { code: 1800, name: 'TEXAS RANGERS BASEBALL CLUB' },
  'TOR':  { code: 1827, name: 'TORONTO BLUE JAYS BASEBALL CLUB / TBJ MERCHANDISING' },
  'WSH':  { code: 1867, name: 'WASHINGTON NATIONALS BASEBALL CLUB' },
  'CLEG': { code: 5616, name: 'CLEVELAND GUARDIANS BASEBALL CLUB' },
};
const APPAREL_TYPES    = [
  't-shirts', 'women', 'youth', 'shorts', 'swim trunks', 'youth shorts',
  'sweatshirt', 'youth sweatshirt', "men's jacket", 'youth jacket',
];

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
  "bigleaguedreamers":"NA",  "bigleaguedreamer":"NA",
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

// ─── MiLB Team Nickname → Trademark Code ─────────────────────────────────────
// Keys = lowercase nickname/city as it appears in SKU parentheses.
// e.g.  MiLB-L-6432(JumboShrimp)-Mens  →  JACJ
// Add entries here when new MiLB team SKUs are introduced.
const MILB_NICKNAME_MAP = {
  // Akron
  "aeros":"AKRO", "akronaeros":"AKRO",
  "rubberducks":"AKRR", "rubber ducks":"AKRR", "akronrubberducks":"AKRR",
  // Albany
  "albanypolecats":"ALBP", "polecats":"ALBP",
  // Albuquerque
  "isotopes":"ALBI", "albuquerque":"ALBI", "albuquerqueisotopes":"ALBI",
  // Altoona
  "curve":"ALTC", "altoona":"ALTC",
  // Amarillo
  "sodpoodles":"ASP", "sod poodles":"ASP", "amarillo":"ASP",
  // Arkansas
  "travelers":"ARKT", "arkansastravelers":"ARKT",
  // Asheville
  "tourists":"ASHT", "asheville":"ASHT",
  // Augusta
  "greenjackets":"AGJ", "green jackets":"AGJ", "augusta":"AGJ",
  // Beloit
  "skycarp":"BELOSC", "sky carp":"BELOSC", "beloit":"BELOSC",
  // Binghamton
  "binghamtonmets":"BING",
  "rumbleponies":"BINR", "rumble ponies":"BINR", "binghamton":"BINR",
  // Biloxi
  "shuckers":"BILS", "biloxi":"BILS",
  // Birmingham
  "barons":"BHMB", "birmingham":"BHMB",
  // Bowling Green
  "hotrods":"BOWH", "hot rods":"BOWH", "bowlinggreen":"BOWH",
  // Bradenton
  "marauders":"BRAM", "bradenton":"BRAM",
  // Brooklyn
  "cyclones":"BKCL", "brooklyn":"BKCL",
  // Buffalo
  "bisons":"BUFF", "buffalo":"BUFF",
  // Cedar Rapids
  "kernels":"CRR", "cedarrapids":"CRR",
  "bunnies":"CDRBUN", "cedarrapidsbunnies":"CDRBUN",
  // Charleston
  "riverdogs":"CRD", "river dogs":"CRD", "charleston":"CRD",
  // Charlotte
  "knights":"CHAR", "charlotte":"CHAR",
  // Chattanooga
  "lookouts":"CHAT", "chattanooga":"CHAT",
  // Chesapeake
  "baysox":"CHSPBSX", "chesapeake":"CHSPBSX",
  // Clearwater
  "threshers":"CLWTR", "clearwater":"CLWTR",
  // Columbia
  "fireflies":"COLF", "columbia":"COLF",
  // Columbus
  "clippers":"COLCL", "columbus":"COLCL",
  "clingstones":"COLCLI", "columbusclingstones":"COLCLI",
  // Connecticut
  "defenders":"COND", "connecticutdefenders":"COND",
  // Corpus Christi
  "hooks":"CCH", "corpus":"CCH", "corpuschristi":"CCH",
  // Dayton
  "dragons":"DAYD", "dayton":"DAYD",
  // Daytona
  "tortugas":"DAYT", "daytona":"DAYT",
  // Delmarva
  "shorebirds":"DELM", "delmarva":"DELM",
  // Down East
  "woodducks":"DOWW", "wood ducks":"DOWW", "downeast":"DOWW",
  // Dunedin
  "dunedinbluejays":"DBJ", "dunedin":"DBJ",
  // Durham
  "durham":"DURB", "bulls":"DURB", "durham bulls":"DURB",
  // El Paso
  "chihuahuas":"ELPC", "elpaso":"ELPC",
  // Erie
  "seawolves":"ERIE", "sea wolves":"ERIE", "erie":"ERIE",
  // Eugene
  "emeralds":"EUGN", "eugene":"EUGN",
  // Everett
  "aquasox":"EVER", "everett":"EVER",
  // Fayetteville
  "woodpeckers":"FYWD", "fayetteville":"FYWD",
  // Fort Myers
  "mightymussels":"FTMYM", "mighty mussels":"FTMYM", "fortmyers":"FTMYM",
  // Fort Wayne
  "tincaps":"FORT", "tin caps":"FORT", "fortwayne":"FORT",
  // Frederick
  "frederickkeys":"FREK", "frederick":"FREK",
  // Fredericksburg
  "fredericksburgnats":"FRDN", "fredericksburg":"FRDN",
  // Fresno
  "grizzlies":"FRES", "fresno":"FRES",
  // Frisco
  "roughriders":"FRIR", "rough riders":"FRIR", "frisco":"FRIR",
  // Great Lakes
  "loons":"GREL", "greatlakes":"GREL",
  // Greensboro
  "grasshoppers":"GRGR", "greensboro":"GRGR",
  // Greenville
  "drive":"GRED", "greenville":"GRED",
  // Gwinnett
  "stripers":"GWIS", "gwinnett":"GWIS",
  // Harrisburg
  "senators":"HBS", "harrisburg":"HBS",
  // Hartford
  "yardgoats":"HARTY", "yard goats":"HARTY", "hartford":"HARTY",
  // Hickory
  "crawdads":"HICC", "hickory":"HICC",
  // Hill City
  "howlers":"HCHOW", "hillcity":"HCHOW",
  // Hillsboro
  "hops":"HILH", "hillsboro":"HILH",
  // Hub City
  "spartanburgers":"HCS", "hubcity":"HCS",
  // Hudson Valley
  "renegades":"HVR", "hudsonvalley":"HVR",
  // Indianapolis
  "indianapolisindians":"IND", "indianapolis":"IND",
  // Inland Empire
  "66ers":"INLS", "inlandempire":"INLS",
  // Iowa
  "iowacubs":"IOWA", "iowa":"IOWA",
  // Jacksonville
  "jumboshrimp":"JACJ", "jumbo shrimp":"JACJ", "jacksonville":"JACJ",
  "jacksonvillesuns":"JKSN",
  // Jersey Shore
  "blueclaws":"JSBC", "blue claws":"JSBC", "jerseyshore":"JSBC",
  // Jupiter
  "hammerheads":"JUPI", "jupiter":"JUPI",
  // Kannapolis
  "cannonballers":"KANCB", "cannon ballers":"KANCB", "kannapolis":"KANCB",
  // Knoxville
  "smokies":"KNOXSM", "knoxville":"KNOXSM",
  // Lake County
  "lakecounty":"LAKC",
  // Lake Elsinore
  "lakeelsinore":"LES", "elsinore":"LES",
  // Lakeland
  "flyingtigers":"LLT", "flying tigers":"LLT", "lakeland":"LLT",
  // Lansing
  "lugnuts":"LANS", "lansing":"LANS",
  // Las Vegas
  "aviators":"LVA", "lasvegas":"LVA",
  // Lehigh Valley
  "ironpigs":"LEHI", "iron pigs":"LEHI", "lehigh":"LEHI",
  // Louisville
  "louisvillebats":"LOUB", "louisville":"LOUB",
  // Memphis
  "redbirds":"MEMP", "memphis":"MEMP",
  // Midland
  "rockhounds":"MLRH", "rock hounds":"MLRH", "midland":"MLRH",
  // Mississippi
  "mississippibraves":"MISB", "mississippi":"MISB",
  // Montgomery
  "biscuits":"MNTB", "montgomery":"MNTB",
  // Myrtle Beach
  "myrtlebeach":"MYRT", "myrtlebeachpelicans":"MYRT",
  // Nashville
  "sounds":"NASH", "nashville":"NASH",
  // New Hampshire
  "fishercats":"NHFC", "fisher cats":"NHFC", "newhampshire":"NHFC",
  // New Orleans
  "babycakes":"NEWBC", "neworleansbabyakes":"NEWBC",
  "neworleanspelicans":"NOP",
  // Norfolk
  "tides":"NORT", "norfolk":"NORT",
  // Northwest Arkansas
  "naturals":"NORN", "nwarkansas":"NORN",
  // Oklahoma City
  "comets":"OKCC", "okc":"OKCC",
  "okcdodgers":"OKLD", "oklahomacitydodgers":"OKLD",
  // Omaha
  "stormchasers":"OMAS", "storm chasers":"OMAS", "omaha":"OMAS",
  // Ontario
  "towerbuzzers":"ONTTB", "ontario":"ONTTB",
  // Palm Beach
  "palmbeachcardinals":"PALC", "palmbeach":"PALC",
  // Pensacola
  "bluewahoos":"PENB", "blue wahoos":"PENB", "pensacola":"PENB",
  // Peoria
  "chiefs":"PEDC", "peoria":"PEDC",
  // Portland
  "seadogs":"PSD", "sea dogs":"PSD", "portlandseadogs":"PSD",
  // Potomac
  "potomaccannons":"POCA",
  // Quad Cities
  "riverbandits":"QCRB", "river bandits":"QCRB", "quadcities":"QCRB",
  // Rancho Cucamonga
  "quakes":"RANQ", "rancho":"RANQ",
  // Reading
  "fightinphils":"RDNG", "fightin phils":"RDNG", "reading":"RDNG",
  // Reno
  "reno":"RENA", "renoaces":"RENA",
  "silversox":"RNSSX", "reno silver sox":"RNSSX",
  // Richmond
  "flyingsquirrels":"RICF", "flying squirrels":"RICF", "richmond":"RICF",
  // Rochester
  "redwings":"RRW", "red wings":"RRW", "rochester":"RRW",
  // Rocket City
  "trashpandas":"RCTP", "trash pandas":"RCTP", "rocketcity":"RCTP",
  // Rome
  "romebraves":"ROMB",
  "emperors":"ROMEE", "romeemperors":"ROMEE",
  // Round Rock
  "express":"RRE", "roundrock":"RRE",
  // Sacramento
  "rivercats":"SACR", "river cats":"SACR", "sacramento":"SACR",
  // Salem
  "ridgeyaks":"SALMRY", "ridge yaks":"SALMRY", "salem":"SALMRY",
  // Salt Lake
  "saltlakebees":"SALB", "saltlake":"SALB",
  // San Antonio
  "missions":"SAM", "sanantonio":"SAM",
  // San Jose
  "sanjosegiants":"SJG", "sanjose":"SJG",
  // Scranton/WB
  "railriders":"SCRR", "rail riders":"SCRR", "scranton":"SCRR",
  // Somerset
  "somersetpatriots":"SOMSPT", "somerset":"SOMSPT",
  // South Bend
  "southbendcubs":"SOUC", "southbend":"SOUC",
  // Spokane
  "spokaneinidians":"SPIN", "spokane":"SPIN",
  // Springfield
  "cardinals":"SPIC", "springfieldcardinals":"SPIC", "springfield":"SPIC",
  // St. Lucie
  "stluciemets":"SAIM", "stlucie":"SAIM",
  // St. Paul
  "saints":"SPS", "stpaul":"SPS",
  // Stockton
  "ports":"STOP", "stockton":"STOP",
  // Sugar Land
  "spacecowboys":"SUGLSC", "space cowboys":"SUGLSC", "sugarland":"SUGLSC",
  // Syracuse
  "syracusemets":"SYRCM", "syracuse":"SYRCM",
  // Tacoma
  "rainiers":"TACO", "tacoma":"TACO",
  // Tampa
  "tarpons":"TAMT", "tampa":"TAMT",
  // Tennessee
  "tennesseesmokies":"TENS", "tennessee":"TENS",
  // Toledo
  "mudhens":"TMH", "mud hens":"TMH", "toledo":"TMH",
  // Tri-City
  "dustdevils":"TCDD", "dust devils":"TCDD", "tricity":"TCDD",
  // Tulsa
  "drillers":"TLSA", "tulsa":"TLSA",
  // Vancouver
  "canadians":"VANC", "vancouver":"VANC",
  // Visalia
  "rawhide":"VISR", "visalia":"VISR",
  // West Michigan
  "whitecaps":"WMWC", "westmichigan":"WMWC",
  // Wichita
  "windsurge":"WTAWS", "wind surge":"WTAWS", "wichita":"WTAWS",
  // Wilmington
  "bluerocks":"WILB", "blue rocks":"WILB", "wilmington":"WILB",
  // Wilson
  "warbirds":"WLWRB", "wilson":"WLWRB",
  // Winston-Salem
  "dash":"WIND", "winstonsalem":"WIND",
  // Wisconsin
  "timberrattlers":"WISC", "timber rattlers":"WISC", "wisconsin":"WISC",
  // Worcester
  "worcesterredsox":"WORCRS", "worcester":"WORCRS",
  // Additional active / historical teams
  "helenabrewers":"HELB",      "helena":"HELB",
  "helenagoldsox":"HGS",
  "huntsvillestars":"HNTS",    "huntsville":"HNTS",
  "gems":"IFG",                "idahofallsgems":"IFG",       "idahofalls":"IFG",
  "idahofallsbraves":"IDFB",
  "jerseyitygiants":"JCG",     "jerseycitygiants":"JCG",
  "peninsulapilots":"PNP",     "peninsula":"PNP",
  "portlandducks":"PORD",
  "pulaski":"PULB",            "pulaskibluejays":"PULB",
  "pulaskimariners":"PULM",    "pulaskicounts":"PILCTS",
  "readingaces":"READA",       "readingpretzels":"READP",
  "rivercityrampage":"RCR",    "rivercityrumblers":"RCRB",
  "riversidepilots":"RSPLT",   "riversideredwave":"RIRW",
  "swingquadcities":"SWTQ",
  "tricityatoms":"TRIC",       "tricityriplets":"TCT",
  "brooklynwonders":"BROOW",
  "connecticuttigers":"CONT",
  "daytonducks":"DUCK",
  "eriesailors":"ERS",
  "evansvilletriplets":"EVAT",
  "greensborobats":"GBAT",
  "idahofallsbraves":"IDFB",
  "kansascityblues":"KCB",
  "conchs":"KWC",              "keywest":"KWC",
  "lodi":"LODC",               "lodicroushers":"LODC",
  "magicians":"LWMA",          "lowell":"LWMA",
  "midlandcubs":"MIDCB",       "midlandangels":"MIDA",
  "montgomeryrebels":"MOR",
  "mudvillenine":"MUDN",
  "oaks":"OAKO",               "oaklandoaks":"OAKO",
  "omahagoldenspikes":"OMAGS",
  "portlandparamounts":"POPA",
  "princewilliamcannons":"PWC",
  "romeromans":"ROMER",
  "saginawjackrabbits":"SGNJKR", "jackrabbits":"SGNJKR", "jack rabbits":"SGNJKR",
  "saltlakecitygulls":"SLCG",  "saltlakecitytrappers":"SLCT",
  "saltlakestingers":"SLST",   "saltlakegulls":"SLTLG",   "saltlakebuzz":"SALTBZ",
  "sarasotareds":"SARR",
  "tampayankees":"TPAY",       "tampasmokers":"TAMP",
  "toledoglasssox":"TOLE",
  "capilanos":"VACA",          "vancouvercapilanos":"VACA", "vancouvermounties":"VAMO",
  "visaliaoaks":"VISO",
  "wichitafallsspudders":"WICHS",
  "winstonsalemspirit":"WSS",
  // Albany
  "albanygov":"ALBG",          "albanytravelers":"ALBT",    "albanypolecats":"ALBP",
  // Allentown
  "allentownredbirds":"ALLRB", "allentownbrooks":"ATB",
  // Amarillo
  "amarillogoldsox":"AGS",     "gold sox":"AGS",
  // Appleton
  "foxes":"APPF",              "apppletonfoxes":"APPF",
  // Asheville
  "moonshiners":"ASHVM",
  // Atlanta
  "crackers":"ATLC",           "atlantacrackers":"ATLC",
  // Auburn
  "auburnamericans":"AUA",     "auburnredstars":"ARS",      "auburnsunsets":"AUBNS",
  // Austin
  "austinsenators":"AUSTSENTR",
  // Bakersfield
  "blaze":"BAKE",              "bakersfieldblaze":"BAKE",
  // Batavia
  "bataviclippers":"BATAC",    "batavia":"BATAC",
  // Baton Rouge
  "cajuns":"BRCA",             "batonrougecajuns":"BRCA",
  "redsticks":"BRRS",          "red sticks":"BRRS",         "batonrougeredsticks":"BRRS",
  // Beaumont
  "exporters":"BEAU",          "beaumontexporters":"BEAU",
  "goldengators":"BGG",        "golden gators":"BGG",
  // Beloit
  "snappers":"BELO",           "beloitsnappers":"BELO",
  // Bend
  "bucks":"BEND",              "bendbucks":"BEND",
  // Binghamton
  "binghamtontriplets":"BHT",
  // Bisbee
  "bisbeecopperkings":"BCK",   "bisbee":"BCK",
  "bisbeedouglascopperkings":"BISC",
  // Bluefield
  "bluefieldorioles":"BLUFO",
  // Bowie
  "bowiebaysox":"BOWB",        "bowie":"BOWB",
  // Bradenton
  "bradentongrow":"BRAGR",
  // Brevard County
  "manatees":"BCM",            "brevard":"BCM",
  // Bristol
  "bristolboosters":"BRB",     "bristolwhitesox":"BRISV",   "bristolstateliners":"BSLI",
  // Buies Creek
  "buiescreekastros":"BUIA",
  // Burlington
  "burlingtonbees":"BURL",
  // Calgary
  "calgarycannons":"CALC",
  // Capitol City
  "capitolcitybombers":"CAPB", "bombers":"CAPB",
  // Casper
  "casperockies":"CARO",       "casper rockies":"CARO",
  // Cape Fear
  "crocs":"CFCRS",             "capefearcros":"CFCRS",
  // Charleston
  "charlestoncharlies":"CHAC", "charlestonrainbows":"CHARR",
  "charlestonwheelers":"CHARW","charlestonalleycats":"CHRAC",
  // Charlotte
  "charlotteos":"CHARO",       "charlotterangers":"CHARRA", "charlottehornets":"CHH",
  // Chesapeake
  "chesapeakebaysox":"CHSPBSX",
  // Clearwater
  "clearwaterphillies":"CLEP",
  // Clinton
  "clintonpilots":"CLP",
  // Colorado Springs
  "coloradospringmillionaires":"COSMIL",
  "skysox":"CSSS",             "sky sox":"CSSS",
  // Columbus
  "columbuscatfish":"COLC",    "columbusjets":"COLJ",       "columbusredbirds":"CRB",
  "columbusredstixx":"COLRS",
  // Connecticut
  "connecticutdefenders":"COND",
  // Dallas
  "dallaseagles":"DALL",       "dallassteers":"DALST",      "dallasfwspurs":"DFTWS",
  "spurs":"DFTWS",
  // Danville
  "danville97s":"DAN97S",
  // Davenport
  "davenportbluesox":"DVNBLSX",
  // Dayton
  "daytonacubs":"DAYC",        "daytonaisanders":"DAYI",
  "daytonaaviatrs":"DAYA",     "daytonabeachadmirals":"DBA",
  // Decatur
  "commies":"DECC",
  // Deland
  "redhats":"DRH",             "red hats":"DRH",
  // Denver
  "denverbears":"DENB",        "zephyrs":"DENZ",            "denverzephyrs":"DENZ",
  // Dublin
  "dublinirish":"DUBL",        "dublingreensox":"DGS",
  // Duluth
  "duluthdukes":"DUDU",
  // Durham
  "tobaccionists":"DURBTBCCS",
  // Eau Claire
  "eauclairebears":"ECB",
  // Edmonton
  "edmontontrappers":"EDMT",
  // El Paso
  "elpasodablos":"EPD",        "elpasosunkings":"EPSK",     "elpasotexans":"EPT",
  // Elmira
  "elmirapioneer":"EMP",
  // Eugene
  "eugenelarks":"EULK",
  // Evansville
  "evansvilletriplets":"EVAT",
  // Fort Myers
  "fortmyersmiracle":"FORM",
  // Fort Wayne
  "fortwayneizards":"FORW",
  // Fox Cities
  "foxcitiesfoxes":"FCF",
  // Fresno
  "fresnoraisiners":"FRER",    "fresnosuns":"FRS",          "fresnosunsox":"FSS",
  // Ft. Worth
  "ftworthcats":"FWC",
  // Gastonia
  "gastoniarangers":"GAR",     "gastoniajets":"GASJ",
  // Gate City
  "gatecitypioners":"GCP",
  // Great Falls
  "greatfallselectrics":"GFE", "greatfallswhitesox":"GREW",
  // Greeneville
  "greenevilleastros":"GRA",
  // Greenville
  "greenvillebombers":"GRB",   "greenvillebraves":"GRNB",   "greenvillespinners":"GRS",
  // Greensboro
  "greensborobats":"GBAT",     "greensborohornets":"GBH",
  // Goldsboro
  "goldbugs":"GGB",
  // Gwinnett
  "gwinnettbraves":"GWIB",
  // Hagerstown
  "owls":"HAGO",               "hagerstownowls":"HAGO",
  // Hardware City
  "hardwarecityrockcats":"HCRC",
  // Hartford
  "hartfordbluebirds":"HARTBB",
  // Havana
  "havanacubans":"HAVC",       "havanasugarkings":"HAVS",
  // Hawaii
  "hawaiiislanders":"HAWI",
  // High Desert
  "mavericks":"HDM",           "highdesertmavericks":"HDM",
  // High Point
  "highpointfurnituremakers":"HPFM",
  // Hollywood
  "hollywoodstars":"HOLS",
  // Hot Springs
  "bathers":"HOTB",            "hotspringsbathers":"HOTB",
  // Houston
  "houstonbuffs":"HOUSB",      "houstonbuffalos":"HOUSBU",
  // Iowa
  "iowaoaks":"IOWAO",
  // Jackson
  "jacksongenerals":"JACG",
  // Jacksonville Beach
  "jacksonvillebeachseabirds":"JBSB",
  // Jamestown
  "jamestownjammers":"JJAM",
  // Jersey City
  "jerseyitygiants":"JCG",
  // Kannapolis
  "intimidators":"KANN",
  // Keokuk
  "keoukukernals":"KEOK",
  // Kingston
  "kingstoneagles":"KING",
  // Kingsport
  "kingsportroyals":"KINGR",
  // Kinston
  "kinstonindians":"KSTN",
  // Kissimmee
  "kissimmeecobras":"KISCO",
  // Knoxville
  "knoxvillesox":"KXVSX",
  // Lakewood
  "lakewoodblueclaws":"LDBC",
  // Las Vegas
  "51s":"LVA",                 "lasvegasstars":"LVGSTRS",
  // Lethbridge
  "lethbridgeblackdiamonds":"LBD", "lethbridgemounties":"LBM",
  // Lexington
  "colts":"LECO",
  // Little Rock
  "littlerocktravelers":"LRT",
  // Lodi
  "lodi":"LODC",
  // Louisiana
  "louisvillecolonials":"LOUC","colonels":"LOUIC",          "riverbats":"LOURB",
  "louisvilleredbirds":"LRB",
  // Lowell
  "lowell":"LWMA",
  // Macon
  "peaches":"MACP",
  // Madison
  "madisonhatters":"MADH",     "muskies":"MADM",
  // Maine
  "maineguides":"MAIN",
  // Miami
  "miamibeachflamingos":"MBF", "miamigos":"MIAA",           "miamiiracle":"MIAM",
  "miamisunsox":"MSSX",
  // Michigan
  "michiganbattlecats":"MIBC",
  // Minneapolis
  "millers":"MINMI",
  // Minot
  "mallards":"MIM",
  // Missoula
  "missoulatimberjacks":"MSTJ",
  // Mobile
  "mobilebears":"MOBE",        "baybears":"MOBI",
  // Modesto
  "modestoas":"MODA",
  // Montgomery
  "montgomeryrebels":"MOR",
  // Montreal
  "montrealroyals":"MONR",
  // Mudville
  "mudvillenine":"MUDN",
  // Myrtle Beach
  "myrtlebeachhurricanes":"MBH",
  // Nashville
  "nashvillevols":"NASHV",     "nashvillexpress":"NASHX",
  // Nevada
  "nevalunatics":"NEVLU",
  // New Britain
  "newbritainrockcats":"NEWB",
  // New Haven
  "newhavenblackcrows":"NHAV", "newhavenravens":"NHR",
  // New Iberia
  "newiberiapelicans":"NEWI",
  // New Jersey
  "newjerseycardinals":"NJC",
  // New Orleans
  "babycakes":"NEWBC",         "neworleanszephyrs":"NEWZ",  "neworleanspelicans":"NOP",
  // Newark
  "newarkbears":"NWB",         "newarkwaynepilots":"NWCP",
  // Niagara Falls
  "niagarafallsrapids":"NFR",
  // Norfolk
  "norfolkclams":"NOC",
  // Oklahoma City
  "89ers":"OKC89",             "okcbaseballclub":"OKCBC",   "oklacityredhawks":"OKL",
  "okcitydodgers":"OKLD",
  // Omaha
  "omaharoyals":"OMAH",
  // Oneonta
  "oneontigers":"ONTG",
  // Orlando
  "orlandorays":"ORLRYS",      "orlandosunrays":"OSR",
  // Ottawa
  "ottawalynx":"OTTL",
  // Panama City
  "panamacityflyers":"PANC",
  // Paris
  "parisredpeppers":"PRP",
  // Pawtucket
  "pawtucketslaters":"PAWS",   "pawtucketredsox":"PSOX",
  // Phoenix
  "phoenixirebirds":"PXFB",
  // Piedmont
  "piedmontbollweevils":"PDBW",
  // Pocatello
  "pocatellogems":"POCAG",     "pocatelloposse":"POCP",
  // Port City
  "portcityroosters":"PCROS",
  // Portland
  "portlandbeavers":"PDBS",    "portlanluckybeavers":"PLB", "portlandrockies":"PROCK",
  // Potomac
  "potomacnationals":"POTN",
  // Princeton
  "princetonpatriots":"PRPAT",
  // Providence
  "providenceclamdiggers":"PCD","providencegrays":"PRG",
  // Provo
  "provoangels":"PROA",
  // Pulaski
  "pulaskimariners":"PULM",    "pulaskicounts":"PILCTS",
  // Quebec
  "quebeccarnavals":"QCARN",   "quebecaces":"QUA",
  // Queens
  "queenskings":"QNKG",
  // Raleigh
  "raleighcapitals":"RAC",
  // Richmond
  "richmondbraves":"RICH",     "richmondvirginians":"RICHM",
  // River City
  "rivercityrumblers":"RCRB",
  // Rockford
  "rockfordcubbies":"RCKFCUB", "rockfordexpos":"ROCKE",
  // Rocky Mount
  "rockymountpines":"RMP",
  // Rome
  "romebraves":"ROMB",
  // Roswell
  "roswellrockets":"ROSW",
  // Redwood
  "redwoodpioneers":"RWP",
  // Sacramento
  "sacramentosolons":"SACS",
  // Saginaw
  "saginawjackrabbits":"SGNJKR",
  // Salem
  "salembuccaneers":"SALBU",   "salemavalanche":"SALE",     "salemraglans":"SARA",
  // Salinas
  "salinaspurs":"SS",
  // San Antonio
  "sanantoniobullets":"SAB",
  // San Bernardino
  "sanbernardsinospirit":"SBS","sanbernardistampede":"SBST",
  // San Francisco
  "sanfranciscoseals":"SANS",  "sanfrancismissions":"SFMI",
  // Sanford
  "sanfordgreyhounds":"SAG",
  // Santa Barbara
  "santabarbaradodgers":"SBD",
  // Savannah
  "sandgnats":"SAVA",          "sand gnats":"SAVA",
  // Scranton
  "scrantonyankees":"SCRY",    "scrantonredbarons":"SRB",
  // Seattle
  "seattlerainiers":"SEAR",
  // Shreveport
  "shreveportcaptains":"SHC",  "shreveportsports":"SHREV",  "shreveportswampdragons":"SPSD",
  // Sioux City
  "siouxcitysoos":"SIOUX",
  // South Bend
  "southbendsilverhawks":"SBSH",
  // Southern Oregon
  "southernoregontimberjacks":"SOTJ",
  // Southwest Michigan
  "devilrays":"SMDR",          "southwestmichigandevilrays":"SMDR",
  // Spokane
  "spokanesmokeaters":"SSE",
  // Springfield
  "springfieldmerchants":"SPRM","sultansofspringfield":"SOS",
  // St. Catharines
  "stcathstompers":"SCSP",
  // St. Cloud
  "stcloudrox":"SCR",
  // St. Petersburg
  "stpetersburgdevilrays":"STPDR","stpetersburgsaints":"STPS",
  // Stockton
  "stocktonfliers":"STKF",
  // Sugar Land
  "skeeters":"SUGLSK",
  // Sumter
  "sumterflyers":"SUMF",
  // Syracuse
  "syracuseskychiefs":"SYCRSCH","syracusechiefs":"SYRA",
  // Tacoma
  "tacomatugs":"TACTG",
  // Tennessee
  "tennesseesmokies":"TENS",
  // Tidewater
  "tidewatertides":"TWT",
  // Toronto
  "torontomapleleafs":"TRML",
  // Tucson
  "tucsonpadres":"TUCP",       "tucsonsidewinders":"TUCS",
  // Tulsa
  "tulsaoilers":"TULSA",
  // Utica
  "uticabluesox":"UTBS",
  // Vancouver
  "vancouvermounties":"VAMO",
  // Ventura County
  "venturacountygulls":"VCG",
  // Vermont
  "vermontexpos":"VEXP",
  // Vero Beach
  "verobeachdodgers":"VBD",    "verobeachdevilrays":"VERD",
  // Virginia
  "virginiagenerals":"VIRG",
  // Walla Walla
  "wallawallapadres":"WWP",
  // Waterloo
  "waterloodiamonds":"WATD",
  // Wausau
  "wausautimbers":"WAUT",
  // West Tenn
  "westtenndiamondjax":"WEST",
  // West Virginia
  "westvirginiawheelers":"WVW",
  // Wichita
  "wichitaaeros":"WICA",       "wichitawranglers":"WICH",   "wichitaviators":"WICHA",
  "wichitawitches":"WICW",     "wichitapilots":"WCHTAPLTS",
  // Williamsport
  "williamsportbills":"WILLB", "williamsportcrosscutters":"WPCC",
  // Wilmington
  "wilmingtonwaves":"WIMW",
  // Winnipeg
  "winnipegwhips":"WINW",
  // Winston-Salem
  "winstonwarthogs":"WINS",
  // Worcester
  "woosox":"WORWS",
  // Yakima
  "yakimabears":"YAKB",
  // York
  "yorkwhiteroses":"YKWR",
};


// ─── MiLB Subcategory Code Map ────────────────────────────────────────────────
// Maps lowercase Shopify product type → MiLB Subcategory_code value
const MILB_SUBCATEGORY_MAP = {
  "t-shirts":         "Tshirts-10056726",              // Adult T-Shirts
  "women":            "Tshirts-10056727",              // Women's T-Shirts
  "youth":            "Tshirts-10056728",              // Youth T-Shirts
  "shorts":           "Bottoms-10044821",              // Adult Shorts
  "swim trunks":      "FashionApparel-10004949",       // Adult Swimwear
  "youth shorts":     "Bottoms-10113156",              // Youth Shorts
  "sweatshirt":       "FleeceTopsSweatshirt-10040819", // Adult Fleece Tops/Sweatshirts
  "youth sweatshirt": "FleeceTopsSweatshirt-10091001", // Youth Fleece Tops/Sweatshirts
  "men's jacket":     "Outerwear-10032555",            // Adult Jackets
  "youth jacket":     "Outerwear-10114549",            // Youth Jackets
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

// ─── Auto-detect Retail Sheet ────────────────────────────────────────────────
// Last resort: if no named sheet matches, scan all sheets and find the one that
// looks like retail data — has columns 'SKU' and 'Product name' and 'Total quantity sold',
// excluding any sheets we already identified as wholesale/export/hardgoods.
function detectRetailSheet(wb, excludeNames) {
  const excluded = new Set((excludeNames || []).filter(Boolean).map(n => n.toLowerCase()));
  const RETAIL_COLS = ['sku', 'product name', 'total quantity sold'];
  for (const name of wb.SheetNames) {
    if (excluded.has(name.toLowerCase())) continue;
    const ws   = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null, header: 1 });
    if (!rows.length) continue;
    const headers = rows[0].map(h => String(h || '').toLowerCase());
    if (RETAIL_COLS.every(col => headers.includes(col))) return name;
  }
  return null;
}

// ─── Fuzzy Sheet Finder ───────────────────────────────────────────────────────
// Case-insensitive, ignores spaces / hyphens / slashes / underscores
// e.g. "MLB Retail-Online", "mlb retail online", "MLB/Retail/Online" all match
function findSheet(wb, targetName) {
  const norm = s => s.toLowerCase().replace(/[\s\-_/]+/g, '');
  const target = norm(targetName);
  return wb.SheetNames.find(name => norm(name) === target) || null;
}

// ─── Persistent file keys (saved between sessions) ───────────────────────────
const PERSISTENT_KEYS = ['shopify'];

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
  document.getElementById('mode-milb').classList.toggle('active', mode === 'milb');
  document.getElementById('check-online').textContent   = mode === 'online'   ? '✓' : '';
  document.getElementById('check-fanatics').textContent = mode === 'fanatics' ? '✓' : '';
  document.getElementById('check-milb').textContent     = mode === 'milb'     ? '✓' : '';

  // Update shopify slot description based on mode
  const shopDesc = document.getElementById('desc-shopify');
  if (shopDesc) {
    shopDesc.textContent = 'Monthly sales export — xlsx or csv';
  }

  // Show/hide file slots based on mode
  document.querySelectorAll('.file-slot').forEach(slot => {
    const isOnline   = slot.classList.contains('mode-online');
    const isFanatics = slot.classList.contains('mode-fanatics');
    const isMilb     = slot.classList.contains('mode-milb');
    const show = (mode === 'online' && isOnline) || (mode === 'fanatics' && isFanatics) || (mode === 'milb' && isMilb);
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
  const REQUIRED = (currentMode === 'fanatics' || currentMode === 'milb')
    ? ['shopify']
    : ['shopify'];

  const allReady = REQUIRED.every(k => files[k] !== null);
  document.getElementById("run-btn").disabled = !allReady;

  const LABELS = {
    shopify: "Shopify Export",
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

// ─── Attribute Mapping (hardcoded) ───────────────────────────────────────────
// All outerwear submits as Lightweight Outerwear (5199-5). Fleece (5199-2) not used.
// Youth Shorts and Swim Trunks roll up into Adult Bottoms (5199-3 adult).
// To add a new product type: add an entry here AND add the type to APPAREL_TYPES.
const ATTR_MAPPING = {
  "t-shirts":         { mlbProductId: '5199-1', attributeCode: 10056726, licenseeDesc: 'T-Shirt' },
  "women":            { mlbProductId: '5199-1', attributeCode: 10056727, licenseeDesc: 'T-Shirt' },
  "youth":            { mlbProductId: '5199-1', attributeCode: 10056728, licenseeDesc: 'T-Shirt' },
  "shorts":           { mlbProductId: '5199-3', attributeCode: 10106180, licenseeDesc: 'Bottoms' },
  "swim trunks":      { mlbProductId: '5199-3', attributeCode: 10106180, licenseeDesc: 'Bottoms' },
  "youth shorts":     { mlbProductId: '5199-3', attributeCode: 10106180, licenseeDesc: 'Bottoms' },
  "sweatshirt":       { mlbProductId: '5199-5', attributeCode: 10032571, licenseeDesc: 'Lightweight Outerwear' },
  "youth sweatshirt": { mlbProductId: '5199-5', attributeCode: 10092153, licenseeDesc: 'Lightweight Outerwear' },
  "men's jacket":     { mlbProductId: '5199-5', attributeCode: 10032571, licenseeDesc: 'Lightweight Outerwear' },
  "youth jacket":     { mlbProductId: '5199-5', attributeCode: 10092153, licenseeDesc: 'Lightweight Outerwear' },
};

// ─── Team Extraction ──────────────────────────────────────────────────────────
function extractTeamFromSku(sku, productName, assetToTeam, teamToAsset) {
  if (!sku) return { assetCode: null, teamName: null, isEvent: false };
  const fullStr = `${sku} ${productName || ''}`.toLowerCase();

  // 1. Check for known multi-team event keywords
  for (const kw of ALL_EVENT_KEYWORDS) {
    if (fullStr.includes(kw.toLowerCase())) {
      return { assetCode: 'MLB', teamName: 'MLB', isEvent: true };
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

  // 3. Fallback: scan SKU word by word (catches e.g. BravesFlag)
  const words = sku.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  for (let len = 4; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const candidate = words.slice(i, i + len).join('').replace(/[^a-z0-9]/g, '');
      const spaced    = words.slice(i, i + len).join(' ').replace(/[^a-z0-9 ]/g, '').trim();
      const code = SKU_NICKNAME_MAP[candidate] || SKU_NICKNAME_MAP[spaced];
      if (code) return { assetCode: code, teamName: assetToTeam[code] || candidate, isEvent: false };
    }
  }

  // 4. SKU found nothing — scan product name
  if (productName) {
    const pwords = productName.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
    for (let len = 4; len >= 1; len--) {
      for (let i = 0; i <= pwords.length - len; i++) {
        const candidate = pwords.slice(i, i + len).join('').replace(/[^a-z0-9]/g, '');
        const spaced    = pwords.slice(i, i + len).join(' ').replace(/[^a-z0-9 ]/g, '').trim();
        const code = SKU_NICKNAME_MAP[candidate] || SKU_NICKNAME_MAP[spaced];
        if (code) return { assetCode: code, teamName: assetToTeam[code] || candidate, isEvent: false };
      }
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
function enrichSheet(ws, assetToTeam, teamToAsset, ATTR_MAPPING) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const enriched = [], flagged = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku         = row['SKU'];
    const productName = row['Product name'];
    const productType = row['Product type'];
    if (!sku && !productName) continue; // skip blank trailing rows
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
    const prodInfo = ATTR_MAPPING[prodKey] || null;
    const usedFallback = !productType && resolvedType;

    // Rows with no product type AND no name-based fallback are non-apparel (e.g. wallets, bats) — skip silently
    if (!productType && !resolvedType) continue;

    const flagReasons = [];
    if (!assetCode && !isEvent) flagReasons.push(`Unknown team in SKU: ${sku}`);
    if (!prodInfo) flagReasons.push(`Product type "${resolvedType || productType}" is not recognized — add it to APPAREL_TYPES and SHOPIFY_TO_ATTR in scripts.js`);
    if (usedFallback && prodInfo) console.log(`Fallback used for row ${i+2}: "${productName}" -> ${resolvedType}`);

    enriched.push({
      productName, sku, productType, qty, gross, discounts, refunds,
      netSales, totalSales, moName, store, teamName, assetCode,
      retailerCode:  RETAILER_CODE,
      retailerName:  RETAILER_NAME,
      licenseeDesc:  prodInfo ? prodInfo.licenseeDesc  : null,
      mlbProductId:  prodInfo ? prodInfo.mlbProductId  : null,
      attributeCode: prodInfo ? prodInfo.attributeCode : null,
      royaltyRate:   ROYALTY_RATE,
      distChannel:   DIST_CHANNEL,
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
        distChannel:   r.distChannel || DIST_CHANNEL,
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
// Returns { attrCode, product } for men's wallet products based on product name.
// Money Clip Wallets → Jewelry > Money Clips, attr 10062362
// Scorebook/Bifold Wallets → Wallets/Purses > Adult, attr 10062364
function getWalletInfo(productName) {
  const lower = productName.toLowerCase();
  if (lower.includes('money clip')) {
    return { attrCode: 10062362, product: 'Hard Goods > Jewelry > Money Clips' };
  }
  return { attrCode: 10062364, product: 'Hard Goods > Personal/Fashion Accessories > Wallets/Purses > Adult' };
}

function parseHardGoodsSheet(ws) {
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });
  // Normalize all column keys to lowercase so lookups work regardless of casing
  const rows    = rawRows.map(r => Object.fromEntries(Object.entries(r).map(([k,v]) => [k.toLowerCase().trim(), v])));
  const output  = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const row         = rows[i];
    const productName = String(row['product name']        || '').trim();
    const sku         = String(row['product sku'] || row['sku'] || '').trim();
    const productType = String(row['product type']        || '').trim().toLowerCase();
    const qty         = Number(row['total quantity sold']) || 0;
    const gross       = Number(row['total gross sales'])   || 0;
    const discount    = Number(row['total discount'] || row['total discounts']) || 0;
    const refund      = Number(row['total refund']   || row['total refunds'])   || 0;
    const netSales    = Number(row['total net sales'])     || 0;
    const moRaw = row['mo'] || row['month'] || row['mo name'] || row['moname'] || '';
    const mo    = moRaw ? String(moRaw).toUpperCase().slice(0, 3) : 'UNK';

    // Skip MiLB rows — if column is missing entirely, assume MLB
    const mlbFlag = row['mlb/milb'];
    if (mlbFlag && mlbFlag !== 'MLB') continue;

    // Skip only if gross is also zero — zero-qty rows with positive gross still need to be reported
    if (qty === 0 && gross === 0) continue;

    // Map product type → attribute code + Fanatics product category
    const prodInfo = HG_PRODUCT_MAP[productType];
    if (!prodInfo) {
      skipped.push(`Row ${i + 2}: Product type "${productType}" is not recognized — add it to HG_PRODUCT_MAP in scripts.js`);
      continue;
    }

    // For wallets, refine product path and attr code by product name
    const walletInfo = prodInfo.attrCode === 10062362 ? getWalletInfo(productName) : null;
    const product  = walletInfo ? walletInfo.product  : prodInfo.product;
    const attrCode = walletInfo ? walletInfo.attrCode : prodInfo.attrCode;

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
      attrCode,
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
    const listPrice = g.qty !== 0 ? +(g.gross    / Math.abs(g.qty)).toFixed(2) : g.gross;
    const unitPrice = g.qty !== 0 ? +(g.netSales / Math.abs(g.qty)).toFixed(2) : g.netSales;

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
function writeMLBSubmission(enriched, hardGoodsGroups, wholesaleGroups, assetToTeam) {
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
  const allGroups = [...apparelGroups, ...(hardGoodsGroups || []), ...(wholesaleGroups || [])].sort((a, b) => {
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
      +r.gross.toFixed(2),                                         // N: Gross Sales (exact from source)
      r.discounts, r.refunds,
      { f: `N${rowNum}-O${rowNum}-P${rowNum}` },                   // Q: Net Sales
      r.royaltyRate, 0,
      { f: `IFERROR(IF(Q${rowNum}<=0,IF((Q${rowNum}*(R${rowNum}/100))<((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum}),(Q${rowNum}*(R${rowNum}/100)),((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum})),IF(((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum})>(Q${rowNum}*(R${rowNum}/100)),((M${rowNum}-(P${rowNum}/L${rowNum}))*S${rowNum}),(Q${rowNum}*(R${rowNum}/100)))),0)` }, // T
      LANGUAGE, r.distChannel || DIST_CHANNEL, CURRENCY, null, null,
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

// ─── MiLB Team Extraction ─────────────────────────────────────────────────────
// Scans a plain text string (space-separated words) for a non-ambiguous MILB_NICKNAME_MAP match.
function scanTextForMiLBTeam(text) {
  if (!text) return null;
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const candidate = words.slice(i, i + len).join('');
      const spaced    = words.slice(i, i + len).join(' ').trim();
      const code = MILB_NICKNAME_MAP[candidate] || MILB_NICKNAME_MAP[spaced];
      if (code) return code;
    }
  }
  return null;
}

// Returns trademark code string, or null if not found in SKU or product name.
function extractMiLBTeamFromSku(sku, productName) {
  if (!sku) return null;
  // 1. Parentheses: MiLB-L-6432(JumboShrimp)-Mens
  const match = sku.match(/\(([^)]+)\)/);
  if (match) {
    const raw  = match[1];
    const code = MILB_NICKNAME_MAP[raw.toLowerCase().replace(/\s+/g, '')] ||
                 MILB_NICKNAME_MAP[raw.toLowerCase()];
    if (code) return code;
  }
  // 2. Word-scan fallback (camelCase split)
  const words = sku.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const candidate = words.slice(i, i + len).join('').replace(/[^a-z0-9]/g, '');
      const spaced    = words.slice(i, i + len).join(' ').replace(/[^a-z0-9 ]/g, '').trim();
      const code = MILB_NICKNAME_MAP[candidate] || MILB_NICKNAME_MAP[spaced];
      if (code) return code;
    }
  }
  // 3. SKU scan found nothing — try product name
  return scanTextForMiLBTeam(productName);
}

// ─── Filter Export to MiLB Retail Rows ───────────────────────────────────────
function filterExportToMiLBRetail(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const filtered = rows.filter(r => {
    if (!String(r['SKU'] || '').startsWith('MiLB-')) return false;
    const pt = (r['Product type'] || '').toLowerCase();
    return pt === '' || APPAREL_TYPES.includes(pt); // empty product type passes through for name-based fallback
  });
  return XLSX.utils.json_to_sheet(filtered);
}

// ─── Write MiLB Submission File ───────────────────────────────────────────────
function writeMiLBSubmission(groups) {
  const headers = [
    'Trademark(*)', 'Territory(*)', 'Subcategory_code(*)', 'Dist_Channel(*)',
    'Gross_Sales(*)', 'Total_Units(*)', 'Royalty_Sales(*)', 'Product description(*)',
    'Retailer_Name(*)', 'Retailer_Code(*)', 'Retailer_Address', 'Retailer_City',
    'Retailer_State', 'Retailer_Zip', 'Retailer_Country', 'Invoice_Date',
    'Invoice_Number', 'UPI', 'License_Type', 'MRU_Units',
  ];
  const wsData = [headers];
  for (const g of groups) {
    wsData.push([
      g.trademark, MILB_TERRITORY, g.subcategoryCode, MILB_DIST_CHANNEL,
      +g.grossSales.toFixed(2), g.totalUnits, +g.royaltySales.toFixed(2),
      g.productDesc,
      (MILB_RETAILER_MAP[g.trademark] || { name: MILB_RETAILER_NAME }).name,
      (MILB_RETAILER_MAP[g.trademark] || { code: MILB_RETAILER_CODE }).code,
      null, null, null, null, null,
      null, null, null, null, null,
    ]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Apply number formats: E=Gross_Sales($), F=Total_Units(int), G=Royalty_Sales($)
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = 1; r <= range.e.r; r++) {
    for (const [c, fmt] of [[4, '$#,##0.00'], [5, '0'], [6, '$#,##0.00']]) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: 'n', v: 0 };
      ws[addr].z = fmt;
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Royalty Statement');
  return wb;
}

// ─── MiLB Mode ────────────────────────────────────────────────────────────────
async function runMiLBMode() {
  log('════════════════════════════════════════════════════════════', 'dim');
  log('  MiLB → MiLB Royalty Submission', 'head');
  log('════════════════════════════════════════════════════════════', 'dim');
  log('');

  try {
    log('📂 Loading Shopify export...', 'info');
    const shopWb = XLSX.read(files.shopify.data, { type: 'array' });
    log(`  Sheets found: ${shopWb.SheetNames.join(', ')}`, 'dim');

    const milbSheetName   = findSheet(shopWb, 'MiLB') || findSheet(shopWb, 'MiLB Retail');
    const exportSheetName = findSheet(shopWb, 'Export');
    let ws;

    if (milbSheetName) {
      ws = shopWb.Sheets[milbSheetName];
      log(`  ✓ Found sheet "${milbSheetName}"`, 'ok');
    } else if (exportSheetName) {
      ws = filterExportToMiLBRetail(shopWb.Sheets[exportSheetName]);
      log(`  ✓ Raw Export detected — auto-filtered to MiLB apparel rows`, 'ok');
    } else {
      ws = shopWb.Sheets[shopWb.SheetNames[0]];
      log(`  ⚠  No "MiLB" or "Export" sheet — trying "${shopWb.SheetNames[0]}"`, 'warn');
    }

    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    log(`  ✓ ${rows.length} row(s) to process`, 'ok');
    log('', 'info');

    const groups  = new Map();
    const skipped = [];
    let monthLabel = 'UNK';

    for (let i = 0; i < rows.length; i++) {
      const row         = rows[i];
      const sku         = String(row['SKU'] || '').trim();
      const productName = String(row['Product name'] || '').trim();
      const productType = String(row['Product type'] || '').trim().toLowerCase();
      const qty         = Number(row['Total quantity sold']) || 0;
      const gross       = stripDollar(row['Total gross sales']);
      const discounts   = stripDollar(row['Total discounts']);
      const refunds     = stripDollar(row['Total refunds']);
      const netSales    = stripDollar(row['Total net sales']);
      const moName      = row['Mo Name'] || row['Mo'] || '';

      if (qty === 0 && gross === 0) continue;
      if (monthLabel === 'UNK' && moName) monthLabel = String(moName).toUpperCase().slice(0, 3);

      // Silently skip MLB- prefix SKUs — they belong to the MLB tool, not MiLB
      if (sku.startsWith('MLB-')) continue;

      const trademark = extractMiLBTeamFromSku(sku, productName);
      if (!trademark) {
        skipped.push(`Row ${i + 2}: MiLB team not recognized in SKU "${sku}" or product name "${productName}" — add the team nickname and trademark code to MILB_NICKNAME_MAP in scripts.js`);
        continue;
      }

      // If Shopify says "youth" but the product name contains "shorts", override to youth shorts
      let resolvedType = productType;
      if (!resolvedType) {
        // Empty product type — infer from product name keywords
        const lname = productName.toLowerCase();
        if (lname.includes('youth') && lname.includes('shorts')) resolvedType = 'youth shorts';
        else if (lname.includes('youth') && lname.includes('jacket')) resolvedType = 'youth jacket';
        else if (lname.includes('youth') && (lname.includes('sweatshirt') || lname.includes('hoodie'))) resolvedType = 'youth sweatshirt';
        else if (lname.includes('youth')) resolvedType = 'youth';
        else if (lname.includes('hoodie') || lname.includes('sweatshirt')) resolvedType = 'sweatshirt';
        else if (lname.includes('shorts')) resolvedType = 'shorts';
        else if (lname.includes('jacket')) resolvedType = "men's jacket";
        else if (lname.includes('anthem') || lname.includes('t-shirt') || lname.includes('tshirt') || lname.includes('tee') || lname.includes('polo')) resolvedType = 't-shirts';
      }
      if (resolvedType === 'youth' && productName.toLowerCase().includes('shorts')) {
        resolvedType = 'youth shorts';
      } else if (resolvedType === 'youth' && productName.toLowerCase().includes('jacket')) {
        resolvedType = 'youth jacket';
      } else if (resolvedType === 'youth' && productName.toLowerCase().includes('sweatshirt')) {
        resolvedType = 'youth sweatshirt';
      }

      const subcategoryCode = MILB_SUBCATEGORY_MAP[resolvedType];
      if (!subcategoryCode) {
        skipped.push(`Row ${i + 2}: Unknown product type "${productType}" (SKU: ${sku})`);
        continue;
      }

      const key = `${trademark}||${subcategoryCode}||${productName}`;
      if (!groups.has(key)) {
        groups.set(key, { trademark, subcategoryCode, productDesc: productName, grossSales: 0, totalUnits: 0, royaltySales: 0, totalDiscounts: 0, totalRefunds: 0 });
      }
      const g = groups.get(key);
      g.grossSales      += gross;
      g.totalUnits      += qty;
      g.totalDiscounts  += discounts;
      g.totalRefunds    += refunds;
      g.royaltySales     = g.grossSales - g.totalDiscounts - g.totalRefunds;
    }

    if (skipped.length > 0) {
      log(`  ⚠  ${skipped.length} row(s) skipped:`, 'warn');
      for (const s of skipped) log(`     ${s}`, 'warn');
      log('', 'info');
    }

    const sorted = Array.from(groups.values()).sort((a, b) => {
      if (a.trademark !== b.trademark) return a.trademark.localeCompare(b.trademark);
      return a.subcategoryCode.localeCompare(b.subcategoryCode);
    });

    if (sorted.length === 0) {
      log('  ❌ No MiLB rows processed. Verify SKUs start with "MiLB-" and product types are recognized.', 'error');
      return;
    }

    log(`  ${'Trademark'.padEnd(10)} | ${'Subcategory'.padEnd(35)} | ${'Units'.padStart(5)} | Royalty Sales`, 'dim');
    log(`  ${'─'.repeat(72)}`, 'dim');
    for (const g of sorted) {
      log(`  ${g.trademark.padEnd(10)} | ${g.subcategoryCode.padEnd(35)} | ${String(g.totalUnits).padStart(5)} | $${g.royaltySales.toFixed(2)}`, 'dim');
    }

    log('', 'info');
    log('📋 Writing MiLB submission file...', 'info');
    const milbWb   = writeMiLBSubmission(sorted);
    const milbName = `milb_submission_${monthLabel}.xlsx`;
    log(`  ✓ ${milbName}`, 'ok');
    addDownload(milbWb, milbName, 'MiLB Royalty Statement — upload to DBH portal');

    log('', 'info');
    log('🎉 Done! Click the button above to download.', 'ok');

  } catch (err) {
    log('', 'info');
    log(`❌ Unexpected error: ${err.message}`, 'error');
    console.error(err);
  }
}

// ─── Main Run ─────────────────────────────────────────────────────────────────
async function runTool() {
  clearLog();
  document.getElementById('run-btn').disabled = true;

  if (currentMode === 'fanatics') {
    await runFanaticsMode();
  } else if (currentMode === 'milb') {
    await runMiLBMode();
  } else {
    await runOnlineMode();
  }

  document.getElementById('run-btn').disabled = false;
}

// ─── Raw Export → Retail Online Sheet ────────────────────────────────────────
// Filters a raw Export sheet down to apparel-only, non-wholesale rows.
// Output worksheet has the same column layout as a pre-split MLB Retail-Online sheet.
function filterExportToRetailOnline(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const filtered = rows.filter(r => {
    const pt = (r['Product type'] || '').toLowerCase();
    const sku = String(r['SKU'] || '');
    // Allow blank product type through so name-based fallback in enrichSheet can handle it
    return (pt === '' || APPAREL_TYPES.includes(pt)) &&
      !WHOLESALE_STORES.includes(r['Store']) &&
      !sku.startsWith('MiLB-');
  });
  return XLSX.utils.json_to_sheet(filtered);
}

// ─── Raw Export → HardGoods Sheet ────────────────────────────────────────────
// Filters a raw Export sheet to hard-goods rows and renames columns to match
// the exact HardGoods schema the parser expects.
function filterExportToHardGoods(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const hgLower = Object.keys(HG_PRODUCT_MAP); // already lowercase
  const mapped = rows
    .filter(r =>
      hgLower.includes((r['Product type'] || '').toLowerCase()) &&
      !WHOLESALE_STORES.includes(r['Store'])
    )
    .map(r => ({
      'Product Name':        r['Product name'],
      'Product SKU':         r['SKU'],
      'Product Type':        r['Product type'],
      'Total Quantity Sold': r['Total quantity sold'],
      'Total Gross Sales':   r['Total gross sales'],
      'Total Discount':      r['Total discounts'],
      'Total Refund':        r['Total refunds'],
      'Total Net sales':     r['Total net sales'],
      'Total Sales':         r['Total Sales'],
      'Mo':                  r['Mo Name'],
      'Store':               r['Store'],
      'MLB/MiLB':            'MLB',
    }));
  return XLSX.utils.json_to_sheet(mapped);
}

// ─── Raw Export → Wholesale MLB Sheet ────────────────────────────────────────
// Filters a raw Export sheet to apparel rows sold through Wholesale - MLB only.
// Only includes MLB- prefixed SKUs (excludes MiLB wholesale).
// Output worksheet retains the same column layout as the Export sheet so that
// enrichSheet() can process it normally.
function filterExportToWholesale(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  const filtered = rows.filter(r =>
    r['Store'] === 'Wholesale - MLB' &&
    APPAREL_TYPES.includes((r['Product type'] || '').toLowerCase()) &&
    String(r['SKU'] || '').startsWith('MLB-')
  );
  return XLSX.utils.json_to_sheet(filtered);
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

    const hardGoodsName = findSheet(shopWb, 'HardGoods');
    const exportName    = findSheet(shopWb, 'Export');
    let ws;

    if (hardGoodsName) {
      ws = shopWb.Sheets[hardGoodsName];
      log(`  ✓ Found sheet "${hardGoodsName}"`, 'ok');
    } else if (exportName) {
      ws = filterExportToHardGoods(shopWb.Sheets[exportName]);
      log(`  ✓ Raw Export sheet detected — auto-filtered to Hard Goods`, 'ok');
    } else {
      log(`  ❌ Neither "HardGoods" nor "Export" sheet found`, 'error');
      log(`     Available sheets: ${shopWb.SheetNames.join(', ')}`, 'dim');
      return;
    }

    log('🛍️  Parsing Hard Goods...', 'info');
    let { groups, skipped } = parseHardGoodsSheet(ws);

    // If named sheet produced nothing, fall back to Export auto-filter
    if (groups.length === 0 && hardGoodsName && exportName) {
      log(`  ⚠  Sheet "${hardGoodsName}" had no usable data — falling back to Export`, 'warn');
      ws = filterExportToHardGoods(shopWb.Sheets[exportName]);
      ({ groups, skipped } = parseHardGoodsSheet(ws));
    }
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
    const shopWb = XLSX.read(files.shopify.data, { type: 'array' });

    const assetToTeam = { ...ASSET_FULL_NAME };
    const teamToAsset = {};
    for (const [code, name] of Object.entries(ASSET_FULL_NAME)) {
      const key = name.toLowerCase();
      if (!teamToAsset[key]) teamToAsset[key] = code;
    }
    log(`  ✓ ${Object.keys(assetToTeam).length} team asset codes (hardcoded)`, 'ok');
    log(`  ✓ ${Object.keys(ATTR_MAPPING).length} product type mappings (hardcoded)`, 'ok');

    log('', 'info');
    log('🔍 Inspecting file...', 'info');
    log(`  Sheets found: ${shopWb.SheetNames.join(', ')}`, 'dim');

    // ── Step 1: Detect whether file is raw or pre-split ───────────────────────
    // Pre-split = already has named sheets (MLB Retail-Online, Wholesale-MLB, etc.)
    // Raw       = single Export sheet with everything mixed together
    // CSV files have no named sheets — treat single-sheet CSVs as raw exports
    const isSingleSheet = shopWb.SheetNames.length === 1;
    const exportSheetName    = findSheet(shopWb, 'Export')
                            || (isSingleSheet ? shopWb.SheetNames[0] : null);
    const wholesaleSheetName = findSheet(shopWb, 'Wholesale-MLB')
                            || findSheet(shopWb, 'WholesaleMLB')
                            || findSheet(shopWb, 'MLB Wholesale')
                            || findSheet(shopWb, 'Wholesale');
    const retailSheetName    = findSheet(shopWb, 'MLB Retail-Online')
                            || findSheet(shopWb, 'MLB')
                            || findSheet(shopWb, 'Online Retail')
                            || findSheet(shopWb, 'Online-Retail')
                            || detectRetailSheet(shopWb, [wholesaleSheetName, exportSheetName]);
    const isRaw = !!exportSheetName && !retailSheetName;

    if (isRaw) {
      log(`  📦 Raw export detected — will auto-filter into retail + wholesale`, 'ok');
    } else {
      log(`  ✅ Pre-split file detected — using existing sheets directly`, 'ok');
    }

    // ── Step 2: Resolve retail worksheet ─────────────────────────────────────
    // Pre-split: use the named sheet. Raw: filter from Export.
    const resolveRetailWs = () => {
      if (retailSheetName) return { ws: shopWb.Sheets[retailSheetName], source: retailSheetName };
      if (exportSheetName) return { ws: filterExportToRetailOnline(shopWb.Sheets[exportSheetName]), source: 'Export (auto-filtered → retail apparel)' };
      return null;
    };

    // ── Step 3: Resolve + process wholesale ──────────────────────────────────
    // Wholesale rows use per-team retailer codes, 14% royalty, INSTLEAG channel.
    let wholesaleGroups = [];
    let wholesaleWs = null;
    let wholesaleSource = '';

    if (wholesaleSheetName) {
      wholesaleWs     = shopWb.Sheets[wholesaleSheetName];
      wholesaleSource = wholesaleSheetName;
    } else if (exportSheetName) {
      const filtered = filterExportToWholesale(shopWb.Sheets[exportSheetName]);
      const count    = XLSX.utils.sheet_to_json(filtered, { defval: null }).length;
      if (count > 0) { wholesaleWs = filtered; wholesaleSource = `Export (auto-filtered → ${count} wholesale rows)`; }
    }

    if (wholesaleWs) {
      log(`  ✓ Wholesale source: ${wholesaleSource}`, 'ok');
      const { enriched: wsEnriched } = enrichSheet(wholesaleWs, assetToTeam, teamToAsset, ATTR_MAPPING);
      let wsSkipped = 0;
      for (const r of wsEnriched) {
        if (r.flagged) {
          log(`  ⚠  Wholesale row skipped — ${r.flagReasons.join('; ')} (SKU: ${r.sku})`, 'warn');
          wsSkipped++; continue;
        }
        const retailer = WHOLESALE_RETAILER_MAP[r.assetCode];
        if (!retailer) {
          log(`  ⚠  Wholesale row skipped — no retailer mapping for asset code "${r.assetCode}" (SKU: ${r.sku}) — add it to WHOLESALE_RETAILER_MAP in scripts.js`, 'warn');
          r.flagged = true; wsSkipped++;
          continue;
        }
        r.retailerCode = retailer.code;
        r.retailerName = retailer.name;
        r.royaltyRate  = WHOLESALE_ROYALTY_RATE;
        r.distChannel  = WHOLESALE_DIST_CHANNEL;
      }
      const validWs = wsEnriched.filter(r => !r.flagged);
      wholesaleGroups = groupRows(validWs, assetToTeam);
      const teamCount = new Set(wholesaleGroups.map(g => g.assetCode)).size;
      log(`  ✓ ${wholesaleGroups.length} wholesale group(s) across ${teamCount} team(s) @ 21% INSTLEAG`, 'ok');
      if (wsSkipped > 0) log(`  ⚠  ${wsSkipped} wholesale row(s) skipped — see details above`, 'warn');
    } else {
      log(`  — No wholesale rows found`, 'dim');
    }
    log('', 'info');

    let monthLabel   = 'UNK';
    let anyProcessed = false;

    for (const { sheetName, label } of SHEETS_TO_PROCESS) {
      const resolved = resolveRetailWs();
      let ws;

      if (resolved) {
        ws = resolved.ws;
        log(`── ${label} (${resolved.source}) ──────────────────────`, 'head');
      } else {
        log(`  ⚠  No retail sheet or Export found — skipping ${label}`, 'warn');
        log(`     Available: ${shopWb.SheetNames.join(', ')}`, 'dim');
        continue;
      }

      log(`🔄 Step 1: Enriching ${label} data...`, 'info');
      const { enriched, flagged } = enrichSheet(ws, assetToTeam, teamToAsset, ATTR_MAPPING);
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

      log(`📋 Step 2: Filling MLB submission template...`, 'info');
      const mlbWb   = writeMLBSubmission(enriched, null, wholesaleGroups, assetToTeam);
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
