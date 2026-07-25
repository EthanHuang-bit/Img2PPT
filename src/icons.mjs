const ICON_ALIASES = Object.freeze({
  analytics: "analytics",
  growth: "analytics",
  chart: "analytics",
  business: "business",
  people: "business",
  users: "business",
  application: "application",
  cube: "application",
  database: "database",
  storage: "database",
  ai: "ai",
  intelligence: "ai",
  server: "server",
  technology: "server",
  customer: "customer",
  customer360: "customer",
  product: "product",
  order: "order",
  billing: "billing",
  charging: "charging",
  marketplace: "marketplace",
  loyalty: "loyalty",
  data: "data",
  operation: "operation",
  operations: "operation",
  crm: "crm",
  arrow: "arrow"
});

export const ICON_KEYS = Object.freeze([
  "none",
  "analytics",
  "business",
  "application",
  "database",
  "ai",
  "server",
  "customer",
  "product",
  "order",
  "billing",
  "charging",
  "marketplace",
  "loyalty",
  "data",
  "operation",
  "crm",
  "arrow",
  "other"
]);

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char]);
}

export function normalizeIconKey(value = "") {
  const compact = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ICON_ALIASES[compact] || (ICON_KEYS.includes(compact) ? compact : "other");
}

function artwork(key) {
  const drawings = {
    analytics: `
      <path d="M10 50h44M15 45V32h8v13M28 45V23h8v22M41 45V13h8v32"/>
      <path d="m13 27 12-9 10 5 15-14"/><path d="m43 9h7v7"/>`,
    business: `
      <circle cx="32" cy="18" r="7"/><circle cx="15" cy="24" r="5"/><circle cx="49" cy="24" r="5"/>
      <path d="M20 51v-9c0-8 5-13 12-13s12 5 12 13v9M7 50v-8c0-6 3-10 9-10 3 0 5 1 7 3M57 50v-8c0-6-3-10-9-10-3 0-5 1-7 3"/>`,
    application: `
      <path d="m32 7 20 11v27L32 57 12 45V18Z"/><path d="m12 18 20 12 20-12M32 30v27"/>`,
    database: `
      <ellipse cx="32" cy="13" rx="19" ry="7"/><path d="M13 13v13c0 4 9 7 19 7s19-3 19-7V13"/>
      <path d="M13 26v13c0 4 9 7 19 7s19-3 19-7V26M13 39v12c0 4 9 7 19 7s19-3 19-7V39"/>`,
    ai: `
      <path d="M27 10c-7 0-11 5-10 11-6 2-8 10-3 14-4 6 0 14 7 14 2 6 10 7 14 3 5 5 14 1 14-6 7-1 10-9 6-14 5-5 2-13-5-15 1-6-4-11-10-11-4-4-12-4-16 0Z"/>
      <path d="M32 12v40M22 20c6 1 8 5 8 10M42 20c-6 1-8 5-8 10M19 37c6-2 10 0 13 5M45 37c-6-2-10 0-13 5"/>`,
    server: `
      <rect x="10" y="9" width="44" height="13" rx="3"/><rect x="10" y="26" width="44" height="13" rx="3"/><rect x="10" y="43" width="44" height="13" rx="3"/>
      <circle cx="17" cy="15.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="17" cy="32.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="17" cy="49.5" r="1.5" fill="currentColor" stroke="none"/>
      <path d="M25 15.5h20M25 32.5h20M25 49.5h20"/>`,
    customer: `
      <circle cx="32" cy="19" r="10"/><path d="M12 55c1-14 8-21 20-21s19 7 20 21"/><path d="M22 42c6 5 14 5 20 0"/>`,
    product: `
      <path d="M9 29 29 9h19l7 7v19L35 55Z"/><circle cx="45" cy="18" r="3"/><path d="m25 30 7 7 16-16"/>`,
    order: `
      <rect x="14" y="10" width="36" height="48" rx="4"/><path d="M24 10V6h16v4M23 24h18M23 34h18M23 44h12"/>
      <path d="m18 23 2 2 4-5m-6 13 2 2 4-5m-6 13 2 2 4-5"/>`,
    billing: `
      <path d="M16 7h32v50l-5-3-5 3-6-3-6 3-5-3-5 3Z"/><path d="M23 19h18M23 29h18M23 39h10"/>
      <circle cx="43" cy="43" r="9" fill="currentColor" stroke="none"/><path d="M40 43h6M43 40v6" stroke="#fff"/>`,
    charging: `
      <path d="M35 5 15 34h14l-2 25 22-34H35Z" fill="currentColor" stroke="none"/>`,
    marketplace: `
      <path d="M9 24h46l-5-14H14Z"/><path d="M12 24v33h40V24M20 57V40h14v17M42 38h5"/>
      <path d="M9 24c0 6 8 8 12 2 4 6 12 4 12-2 0 6 8 8 12 2 4 6 10 3 10-2"/>`,
    loyalty: `
      <path d="M32 56S8 42 8 24C8 12 23 7 32 18c9-11 24-6 24 6 0 18-24 32-24 32Z"/>
      <path d="m32 24 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z"/>`,
    data: `
      <path d="M8 13h17v14H8zM39 8h17v14H39zM39 42h17v14H39zM8 38h17v14H8z"/>
      <path d="M25 20h7v29h7M25 45h7M32 15h7"/>`,
    operation: `
      <path d="M37 9a13 13 0 0 0-14 17L8 41l15 15 15-15a13 13 0 0 0 17-14l-9 9-10-3-3-10Z"/>
      <path d="m12 45 7 7"/>`,
    crm: `
      <rect x="8" y="10" width="48" height="44" rx="5"/><circle cx="22" cy="27" r="7"/><path d="M12 48c1-8 5-13 10-13s9 5 10 13M39 21h10M39 30h10M39 39h10"/>`,
    arrow: `<path d="M7 32h45M38 16l16 16-16 16"/>`
  };
  return drawings[key] || drawings.application;
}

export function catalogIconSvg(iconKey, colorHex = "333333", title = "Recommended vector icon") {
  const key = normalizeIconKey(iconKey);
  const safeColor = /^[0-9A-F]{6}$/i.test(colorHex) ? colorHex : "333333";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" color="#${safeColor}">
    <title>${escapeXml(title)}</title>
    <g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${artwork(key)}</g>
  </svg>`;
}
