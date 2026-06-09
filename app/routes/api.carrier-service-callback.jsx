import crypto from "crypto";
import { unauthenticated } from "../shopify.server";

/* ============================================================
   METAOBJECT TYPE HANDLES
   Matches exactly what you have in Shopify Admin.
============================================================ */
const META_TYPE_CONFIG = "vendor_shipping_config";  // one entry per vendor
const META_TYPE_ZONE   = "vendor_shipping_zone";    // one entry per zone

/* ============================================================
   IN-MEMORY CACHE  (5-minute TTL)
============================================================ */
const CONFIG_CACHE = {
  vendorMap: null,
  fetchedAt: 0,
  TTL_MS: 5 * 60 * 1000,
};

/* ============================================================
   GRAPHQL QUERIES
============================================================ */

// Reads all vendor_shipping_config entries (flat_rate / free / weight_based / zone_based metadata)
const VENDOR_CONFIG_QUERY = `#graphql
  query GetVendorShippingConfigs {
    metaobjects(type: "${META_TYPE_CONFIG}", first: 50) {
      nodes {
        id
        fields { key value }
      }
    }
  }
`;

// Reads all vendor_shipping_zone entries (one row per zone, linked by vendor_name)
const VENDOR_ZONES_QUERY = `#graphql
  query GetVendorShippingZones {
    metaobjects(type: "${META_TYPE_ZONE}", first: 250) {
      nodes {
        id
        fields { key value }
      }
    }
  }
`;

/* ============================================================
   CONFIG LOADER
   Fetches both Metaobject types in parallel, then assembles
   a Map<vendorName, config> used by the rate calculators.
============================================================ */
async function loadVendorConfigs(shop) {
  const now = Date.now();

  if (CONFIG_CACHE.vendorMap && now - CONFIG_CACHE.fetchedAt < CONFIG_CACHE.TTL_MS) {
    console.log("[Config] Using cached vendor configs");
    return CONFIG_CACHE.vendorMap;
  }

  console.log("[Config] Fetching from Admin API...");

  try {
    const { admin } = await unauthenticated.admin(shop);

    // Fetch both types in parallel
    const [configRes, zoneRes] = await Promise.all([
      admin.graphql(VENDOR_CONFIG_QUERY),
      admin.graphql(VENDOR_ZONES_QUERY),
    ]);

    const configData = await configRes.json();
    const zoneData   = await zoneRes.json();

    const configNodes = configData?.data?.metaobjects?.nodes || [];
    const zoneNodes   = zoneData?.data?.metaobjects?.nodes   || [];

    if (configNodes.length === 0) {
      console.log("[Config] No vendor_shipping_config entries — using fallback");
      // return buildFallbackVendorMap();
    }

    /* ── Step 1: Group zones by vendor_name ── */
    // zonesByVendor: Map<vendorName, PostcodeZone[]>
    const zonesByVendor = new Map();

    for (const node of zoneNodes) {
      const f          = fieldsToObject(node.fields);
      const vendorName = f.vendor_name?.trim();
      if (!vendorName) continue;

      const zone = parseZoneEntry(f);
      if (!zonesByVendor.has(vendorName)) zonesByVendor.set(vendorName, []);
      zonesByVendor.get(vendorName).push(zone);
    }

    console.log(`[Config] Loaded zones for ${zonesByVendor.size} vendor(s)`);

    /* ── Step 2: Build vendorMap from config entries ── */
    const vendorMap = new Map();

    for (const node of configNodes) {
      const f          = fieldsToObject(node.fields);
      const vendorName = f.vendor_name?.trim();
      if (!vendorName) { console.warn("[Config] Entry missing vendor_name, skipping"); continue; }

      const config = parseConfigEntry(f, zonesByVendor.get(vendorName) || []);
      vendorMap.set(vendorName, config);
      console.log(`[Config] ✓ "${vendorName}" — type: ${config.shippingType}, zones: ${config.postcodeZones.length}`);
    }

    CONFIG_CACHE.vendorMap = vendorMap;
    CONFIG_CACHE.fetchedAt = now;
    return vendorMap;

  } catch (error) {
    console.error("[Config] Admin API error — using fallback:", error);
    return buildFallbackVendorMap();
  }
}

/* ============================================================
   PARSER: vendor_shipping_config entry
   Fields from your Metaobject definition:
     vendor_name            Single line text
     shipping_type          Choice list  (flat_rate|zone_based|weight_based|free)
     free_threshold_cents   Integer      (optional)
     free_shipping_min_days Integer      (optional, delivery window when free)
     free_shipping_max_days Integer      (optional, delivery window when free)
     fallback_rate_cents    Integer      (optional, used when no zone matches)  ← ADD THIS FIELD
     shipping_options       JSON         (array of ShippingOption — see below)
     currency               Single line text (optional, defaults to AUD)
============================================================ */
function parseConfigEntry(f, postcodeZones) {
  let shippingOptions = [];
  if (f.shipping_options) {
    try   { shippingOptions = JSON.parse(f.shipping_options); }
    catch (e) { console.error(`[Config] Bad shipping_options JSON for "${f.vendor_name}":`, e); }
  }

  return {
    vendorName:           f.vendor_name?.trim() || "",
    shippingType:         f.shipping_type?.trim() || "flat_rate",
    freeThresholdCents:   parseIntSafe(f.free_threshold_cents, null),
    freeShippingMinDays:  parseIntSafe(f.free_shipping_min_days, 2),
    freeShippingMaxDays:  parseIntSafe(f.free_shipping_max_days, 5),
    fallbackRateCents:    parseIntSafe(f.fallback_rate_cents, 1500),
    currency:             f.currency?.trim() || "AUD",
    shippingOptions,      // used by flat_rate and weight_based
    postcodeZones,        // populated from vendor_shipping_zone entries
  };
}

/* ============================================================
   PARSER: vendor_shipping_zone entry
   Fields from your Metaobject definition:
     vendor_name       Single line text  (links to vendor_shipping_config)
     zone_name         Single line text
     service_name      Single line text
     service_code      Single line text
     rate_cents        Integer
     min_delivery_days Integer
     max_delivery_days Integer
     exact_postcodes   Multi-line text   (comma-separated, e.g. "4472, 4473, 4478")
     postcode_ranges   JSON              (array of {from, to} objects)
============================================================ */
function parseZoneEntry(f) {
  // Parse exact_postcodes: "4076, 4472, 4473" → ["4076", "4472", "4473"]
  const exact = f.exact_postcodes
    ? f.exact_postcodes.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Parse postcode_ranges JSON: [{"from": 4000, "to": 4308}, ...]
  let ranges = [];
  if (f.postcode_ranges) {
    try   { ranges = JSON.parse(f.postcode_ranges); }
    catch (e) { console.error(`[Config] Bad postcode_ranges JSON for zone "${f.zone_name}":`, e); }
  }

  return {
    name:        f.zone_name     || "Unknown Zone",
    serviceName: f.service_name  || "Standard Shipping",
    serviceCode: f.service_code  || "STANDARD",
    rateCents:   parseIntSafe(f.rate_cents, 1500),
    minDays:     parseIntSafe(f.min_delivery_days, 2),
    maxDays:     parseIntSafe(f.max_delivery_days, 5),
    exact:       exact.length > 0 ? exact : undefined,
    ranges:      ranges.length > 0 ? ranges : undefined,
  };
}

/* ============================================================
   ACTION — Shopify carrier service entry point
============================================================ */
export async function action({ request }) {
  const body = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-SHA256");
  const shop = request.headers.get("X-Shopify-Shop-Domain");

  // HMAC validation
  if (hmac && process.env.SHOPIFY_API_SECRET) {
    const hash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(body, "utf8")
      .digest("base64");

    if (hash !== hmac) {
      return new Response(JSON.stringify({ error: "Invalid HMAC" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const rateRequest = JSON.parse(body);
  const { rate } = rateRequest;

  try {
    const vendorMap = await loadVendorConfigs(shop);
    const rates     = calculateShippingRates(rate, vendorMap);

    return new Response(JSON.stringify({ rates }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Shipping error:", error);
    return new Response(JSON.stringify({ rates: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/* ============================================================
   MAIN SHIPPING CALCULATOR
============================================================ */
function calculateShippingRates(rate, vendorMap) {
  const { destination, items, currency, order_totals, customer } = rate;

  const vendors = [...new Set(items.map((i) => i.vendor).filter(Boolean))];

  console.log("=== SHIPPING CALCULATION ===");
  console.log("Vendors:", vendors);
  console.log("Destination:", destination?.postal_code, destination?.country);

  const itemsByVendor = items.reduce((acc, item) => {
    const v = item.vendor || "Unknown";
    if (!acc[v]) acc[v] = [];
    acc[v].push(item);
    return acc;
  }, {});

  /* ── Single vendor ── */
  if (vendors.length === 1) {
    const vendor = vendors[0];
    const config = vendorMap.get(vendor);

    if (config) {
      console.log(`Single vendor "${vendor}" — type: ${config.shippingType}`);
      return calculateVendorRates(config, itemsByVendor[vendor], destination, currency);
    }

    console.log(`"${vendor}" not in Metaobjects — using default rates`);
    return calculateDefaultRates(items, order_totals, customer, currency);
  }

  /* ── Multiple vendors — sum each vendor's cost ── */
  console.log("Multiple vendors — calculating combined rate");

  let totalCost = 0;
  const breakdown = [];

  for (const vendor of vendors) {
    const vendorItems = itemsByVendor[vendor];
    const config      = vendorMap.get(vendor);
    let vendorCost    = 0;

    if (config) {
      vendorCost = resolveVendorCostForCombined(config, vendorItems, destination);
      breakdown.push(`${vendor}: $${(vendorCost / 100).toFixed(2)}`);
      console.log(`  "${vendor}": $${vendorCost / 100} (${config.shippingType})`);
    } else {
      const kg = vendorItems.reduce((s, i) => s + i.grams * i.quantity, 0) / 1000;
      vendorCost = calculateWeightRate(kg);
      breakdown.push(`${vendor}: $${(vendorCost / 100).toFixed(2)} (default)`);
      console.log(`  "${vendor}": $${vendorCost / 100} (default weight-based)`);
    }

    totalCost += vendorCost;
  }

  return [{
    service_name:      "Combined Shipping",
    service_code:      "COMBINED_MULTI_VENDOR",
    total_price:       totalCost.toString(),
    description:       `Breakdown: ${breakdown.join(" | ")}`,
    currency:          currency || "AUD",
    min_delivery_date: addBusinessDays(new Date(), 2),
    max_delivery_date: addBusinessDays(new Date(), 7),
  }];
}

/* ============================================================
   VENDOR RATE CALCULATOR  — dispatches on shipping_type
============================================================ */
function calculateVendorRates(config, items, destination, currency) {
  const cur      = config.currency || currency || "AUD";
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

  switch (config.shippingType) {

    /* ── flat_rate ─────────────────────────────────────────────
       Uses shipping_options JSON for the paid options.
       If free_threshold_cents is set and subtotal qualifies,
       shows Free Shipping instead (uses free_shipping_min/max_days).
    ────────────────────────────────────────────────────────── */
    case "flat_rate": {
      // Free threshold check
      if (config.freeThresholdCents !== null && subtotal >= config.freeThresholdCents) {
        console.log(`  flat_rate FREE: subtotal ${subtotal} >= threshold ${config.freeThresholdCents}`);
        return [{
          service_name:      "Free Shipping",
          service_code:      `${sanitizeCode(config.vendorName)}_FREE`,
          total_price:       "0",
          description:       `Free shipping on orders over $${config.freeThresholdCents / 100}`,
          currency:          cur,
          min_delivery_date: addBusinessDays(new Date(), config.freeShippingMinDays),
          max_delivery_date: addBusinessDays(new Date(), config.freeShippingMaxDays),
        }];
      }

      // Paid options
      if (config.shippingOptions.length === 0) {
        console.warn(`  flat_rate: no shipping_options for "${config.vendorName}" — fallback`);
        return [makeFallbackRate(config.fallbackRateCents, cur)];
      }

      return config.shippingOptions.map((opt) => ({
        service_name:      opt.service_name,
        service_code:      opt.service_code,
        total_price:       String(opt.price_cents),
        description:       opt.description || "",
        currency:          cur,
        min_delivery_date: addBusinessDays(new Date(), opt.min_days ?? 2),
        max_delivery_date: addBusinessDays(new Date(), opt.max_days ?? 5),
      }));
    }

    /* ── zone_based ────────────────────────────────────────────
       Matches destination postcode against vendor_shipping_zone
       entries (loaded into config.postcodeZones).
    ────────────────────────────────────────────────────────── */
    case "zone_based": {
      const zone = matchPostcodeZone(destination, config.postcodeZones);

      if (zone) {
        console.log(`  zone_based: matched "${zone.name}" — $${zone.rateCents / 100}`);
        return [{
          service_name:      zone.serviceName,
          service_code:      zone.serviceCode,
          total_price:       String(zone.rateCents),
          description:       `Shipping to ${zone.name}`,
          currency:          cur,
          min_delivery_date: addBusinessDays(new Date(), zone.minDays),
          max_delivery_date: addBusinessDays(new Date(), zone.maxDays),
        }];
      }

      console.log(`  zone_based: no match for ${destination?.postal_code} — fallback $${config.fallbackRateCents / 100}`);
      return [makeFallbackRate(config.fallbackRateCents, cur)];
    }

    /* ── weight_based ──────────────────────────────────────────
       Price derived from total item weight. Uses
       shipping_options[0] for the service label/code.
    ────────────────────────────────────────────────────────── */
    case "weight_based": {
      const kg         = items.reduce((s, i) => s + i.grams * i.quantity, 0) / 1000;
      const priceCents = calculateWeightRate(kg);
      const opt        = config.shippingOptions[0];

      console.log(`  weight_based: ${kg.toFixed(2)}kg → $${priceCents / 100}`);
      return [{
        service_name:      opt?.service_name || "Standard Shipping",
        service_code:      opt?.service_code || `${sanitizeCode(config.vendorName)}_WEIGHT`,
        total_price:       String(priceCents),
        description:       opt?.description  || `Shipping (${kg.toFixed(2)}kg)`,
        currency:          cur,
        min_delivery_date: addBusinessDays(new Date(), opt?.min_days ?? 5),
        max_delivery_date: addBusinessDays(new Date(), opt?.max_days ?? 7),
      }];
    }

    /* ── free ──────────────────────────────────────────────────
       Always free. Delivery window from free_shipping_min/max_days.
    ────────────────────────────────────────────────────────── */
    case "free": {
      console.log(`  free: always free for "${config.vendorName}"`);
      return [{
        service_name:      "Free Shipping",
        service_code:      `${sanitizeCode(config.vendorName)}_FREE`,
        total_price:       "0",
        description:       "Free shipping",
        currency:          cur,
        min_delivery_date: addBusinessDays(new Date(), config.freeShippingMinDays),
        max_delivery_date: addBusinessDays(new Date(), config.freeShippingMaxDays),
      }];
    }

    default: {
      console.warn(`  Unknown shipping_type "${config.shippingType}" for "${config.vendorName}"`);
      return [makeFallbackRate(config.fallbackRateCents, cur)];
    }
  }
}

/* ============================================================
   COMBINED RATE RESOLVER
   Returns a single number for a vendor when combining multiple
   vendors. Picks the cheapest/primary option.
============================================================ */
function resolveVendorCostForCombined(config, items, destination) {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

  switch (config.shippingType) {
    case "flat_rate":
      if (config.freeThresholdCents !== null && subtotal >= config.freeThresholdCents) return 0;
      if (config.shippingOptions.length > 0)
        return Math.min(...config.shippingOptions.map((o) => o.price_cents));
      return config.fallbackRateCents;

    case "zone_based": {
      const zone = matchPostcodeZone(destination, config.postcodeZones);
      return zone ? zone.rateCents : config.fallbackRateCents;
    }

    case "weight_based": {
      const kg = items.reduce((s, i) => s + i.grams * i.quantity, 0) / 1000;
      return calculateWeightRate(kg);
    }

    case "free":
      return 0;

    default:
      return config.fallbackRateCents;
  }
}

/* ============================================================
   DEFAULT RATES — for vendors not in any Metaobject
============================================================ */
function calculateDefaultRates(items, order_totals, customer, currency) {
  const totalWeight = items.reduce((s, i) => s + i.grams * i.quantity, 0);
  const totalValue  = order_totals?.subtotal_price
    ? parseInt(order_totals.subtotal_price)
    : items.reduce((s, i) => s + i.price * i.quantity, 0);

  const kg       = totalWeight / 1000;
  const discount = customer?.tags?.includes("VIP") ? 0.9 : 1.0;
  const rates    = [];

  if (kg <= 25) {
    let base = 800;
    if (kg > 5) base += Math.ceil((kg - 5) / 5) * 400;
    rates.push({
      service_name: "Standard Shipping", service_code: "STANDARD",
      total_price:  String(Math.round(base * discount)),
      description:  "Delivery in 5–7 business days", currency: currency || "AUD",
      min_delivery_date: addBusinessDays(new Date(), 5),
      max_delivery_date: addBusinessDays(new Date(), 7),
    });
  }

  if (kg <= 20) {
    let exp = 1600;
    if (kg > 5) exp += Math.ceil((kg - 5) / 5) * 600;
    rates.push({
      service_name: "Express Shipping", service_code: "EXPRESS",
      total_price:  String(Math.round(exp * discount)),
      description:  "Delivery in 2–3 business days", currency: currency || "AUD",
      min_delivery_date: addBusinessDays(new Date(), 2),
      max_delivery_date: addBusinessDays(new Date(), 3),
    });
  }

  if (totalValue >= 10000 && kg <= 20) {
    rates.push({
      service_name: "Free Standard Shipping", service_code: "FREE_STANDARD",
      total_price:  "0", description: "Free shipping on orders over $100",
      currency:     currency || "AUD",
      min_delivery_date: addBusinessDays(new Date(), 5),
      max_delivery_date: addBusinessDays(new Date(), 7),
    });
  }

  return rates;
}

/* ============================================================
   FALLBACK VENDOR MAP
   Used when the Admin API call fails or returns no entries.
   Mirrors the original hardcoded values exactly.
============================================================ */
function buildFallbackVendorMap() {
  const map = new Map();

  map.set("Precise Medical Supplies postage", {
    vendorName:          "Precise Medical Supplies postage",
    shippingType:        "flat_rate",
    freeThresholdCents:  25000,
    freeShippingMinDays: 2,
    freeShippingMaxDays: 5,
    fallbackRateCents:   1500,
    currency:            "AUD",
    shippingOptions: [
      { service_name: "AusPost Express", service_code: "AUSPOST_EXPRESS",
        price_cents: 1500, description: "Express delivery via Australia Post", min_days: 1, max_days: 3 },
      { service_name: "StarTrack", service_code: "STARTRACK",
        price_cents: 2000, description: "Fast delivery via StarTrack", min_days: 1, max_days: 3 },
    ],
    postcodeZones: [],
  });

  map.set("Medtech Marketplace", {
    vendorName:          "Medtech Marketplace",
    shippingType:        "zone_based",
    freeThresholdCents:  null,
    freeShippingMinDays: 2,
    freeShippingMaxDays: 5,
    fallbackRateCents:   1500,
    currency:            "AUD",
    shippingOptions:     [],
    postcodeZones: [
      { name:"QLD Metro",    serviceName:"QLD Metro Shipping",    serviceCode:"MEDTECH_QLD_METRO",    rateCents:1500, minDays:2, maxDays:5, ranges:[{from:4000,to:4308},{from:4500,to:4579}] },
      { name:"QLD South",    serviceName:"QLD South Shipping",    serviceCode:"MEDTECH_QLD_SOUTH",    rateCents:1500, minDays:2, maxDays:5, exact:["4719"], ranges:[{from:3997,to:4471},{from:4474,to:4477},{from:4479,to:4480},{from:4486,to:4676},{from:9000,to:9999}] },
      { name:"QLD Central",  serviceName:"QLD Central Shipping",  serviceCode:"MEDTECH_QLD_CENTRAL",  rateCents:3000, minDays:2, maxDays:5, exact:["4472","4473","4478"], ranges:[{from:4481,to:4485},{from:4677,to:4718},{from:4720,to:4803}] },
      { name:"QLD North",    serviceName:"QLD North Shipping",    serviceCode:"MEDTECH_QLD_NORTH",    rateCents:4000, minDays:2, maxDays:5, ranges:[{from:4804,to:4999}] },
      { name:"NSW Metro",    serviceName:"NSW Metro Shipping",    serviceCode:"MEDTECH_NSW_METRO",    rateCents:1500, minDays:2, maxDays:5, exact:["2158","2320"], ranges:[{from:1000,to:1935},{from:2000,to:2079},{from:2085,to:2249},{from:2557,to:2567},{from:2740,to:2764},{from:2766,to:2777},{from:2890,to:2897}] },
      { name:"NSW Regional", serviceName:"NSW Regional Shipping", serviceCode:"MEDTECH_NSW_REGIONAL", rateCents:2500, minDays:2, maxDays:5, exact:["2108","2157","2159","2173"], ranges:[{from:1936,to:1999},{from:2080,to:2084},{from:2230,to:2231},{from:2560,to:2563},{from:2568,to:2599},{from:2619,to:2739},{from:2745,to:2746},{from:2752,to:2758},{from:2765,to:2765},{from:2775,to:2775},{from:2778,to:2889},{from:2898,to:2899},{from:2921,to:2999}] },
      { name:"VIC Metro",    serviceName:"VIC Metro Shipping",    serviceCode:"MEDTECH_VIC_METRO",    rateCents:1500, minDays:2, maxDays:5, ranges:[{from:3000,to:3062},{from:3064,to:3098},{from:3101,to:3210},{from:3335,to:3338},{from:3427,to:3429},{from:3984,to:3986},{from:8000,to:8999}] },
      { name:"VIC Regional", serviceName:"VIC Regional Shipping", serviceCode:"MEDTECH_VIC_REGIONAL", rateCents:2500, minDays:2, maxDays:5, exact:["3063","3139"], ranges:[{from:3099,to:3100},{from:3211,to:3334},{from:3339,to:3426},{from:3430,to:3983},{from:3987,to:3996}] },
      { name:"SA Metro",     serviceName:"SA Metro Shipping",     serviceCode:"MEDTECH_SA_METRO",     rateCents:1500, minDays:2, maxDays:5, exact:["5653","5660"], ranges:[{from:5000,to:5113},{from:5115,to:5117},{from:5125,to:5130},{from:5158,to:5169},{from:5312,to:5319},{from:5455,to:5459},{from:5486,to:5489},{from:5800,to:5999}] },
      { name:"SA Regional",  serviceName:"SA Regional Shipping",  serviceCode:"MEDTECH_SA_REGIONAL",  rateCents:4000, minDays:2, maxDays:5, exact:["5114"], ranges:[{from:5118,to:5124},{from:5131,to:5157},{from:5170,to:5311},{from:5320,to:5454},{from:5460,to:5485},{from:5490,to:5652},{from:5654,to:5659},{from:5661,to:5799}] },
      { name:"WA Metro",     serviceName:"WA Metro Shipping",     serviceCode:"MEDTECH_WA_METRO",     rateCents:2500, minDays:2, maxDays:5, exact:["6214"], ranges:[{from:6000,to:6038},{from:6050,to:6083},{from:6090,to:6182},{from:6208,to:6211},{from:6556,to:6558}] },
      { name:"WA Regional",  serviceName:"WA Regional Shipping",  serviceCode:"MEDTECH_WA_REGIONAL",  rateCents:4000, minDays:2, maxDays:5, ranges:[{from:6039,to:6049},{from:6084,to:6089},{from:6183,to:6207},{from:6212,to:6213},{from:6215,to:6555},{from:6559,to:6999}] },
      { name:"ACT",          serviceName:"ACT Metro Shipping",    serviceCode:"MEDTECH_ACT_METRO",    rateCents:3000, minDays:2, maxDays:5, ranges:[{from:0,to:299},{from:2600,to:2618},{from:2900,to:2920}] },
      { name:"NT",           serviceName:"Northern Territory",    serviceCode:"MEDTECH_NT",            rateCents:3000, minDays:2, maxDays:5, ranges:[{from:800,to:999}] },
      { name:"TAS",          serviceName:"TAS Shipping",          serviceCode:"MEDTECH_TAS",           rateCents:4000, minDays:2, maxDays:5, ranges:[{from:7000,to:7999}] },
    ],
  });

  console.log("[Config] Using built-in fallback vendor map");
  return map;
}

/* ============================================================
   HELPERS
============================================================ */

function fieldsToObject(fields) {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
}

function parseIntSafe(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function sanitizeCode(vendorName) {
  return vendorName.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 30);
}

function makeFallbackRate(rateCents, currency) {
  return {
    service_name: "Standard Shipping", service_code: "STANDARD_FALLBACK",
    total_price:  String(rateCents),   description: "Standard delivery",
    currency,
    min_delivery_date: addBusinessDays(new Date(), 3),
    max_delivery_date: addBusinessDays(new Date(), 7),
  };
}

function calculateWeightRate(kg) {
  let base = 800;
  if (kg > 5) base += Math.ceil((kg - 5) / 5) * 400;
  return base;
}

function getNumericPostcode(postcode = "") {
  const match = postcode.match(/\d+/);
  if (!match) return null;
  return parseInt(match[0].padStart(4, "0"), 10);
}

function matchPostcodeZone(destination, zones) {
  if (!destination?.postal_code || destination.country !== "AU") return null;
  const numeric = getNumericPostcode(destination.postal_code);
  if (numeric === null) return null;

  return zones.find((zone) => {
    if (zone.exact?.includes(destination.postal_code)) return true;
    return zone.ranges?.some((r) => numeric >= r.from && numeric <= r.to) ?? false;
  });
}

function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const d = result.getDay();
    if (d !== 0 && d !== 6) added++;
  }
  return result.toISOString().split("T")[0];
}