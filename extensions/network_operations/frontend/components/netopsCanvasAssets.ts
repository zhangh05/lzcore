// ---------------------------------------------------------------------------
// netopsCanvasAssets.ts
//
// Returns SVG data-URIs so Cytoscape can rasterise each icon at the current
// zoom × pixelRatio on every redraw.  A 118×97-px PNG stays at 118 px
// regardless of canvas zoom — at zoom≥2 it is visibly blurry.  SVG scales
// to any size without quality loss.
//
// Encoding: `encodeURIComponent` produces a valid data URI that Cytoscape's
// image loader accepts without CORS restrictions (no network round-trip).
//
// Colour palette matches the original PNGs:
//   BLUE  (#1d6fa5) — network-infrastructure icons (switch, router, server…)
//   AMBER (#e8a538) — miscellaneous device icons (wireless, wan, phone…)
// ---------------------------------------------------------------------------

const BLUE = "#1d6fa5";
const AMBER = "#e8a538";
const W = "white";

function dataUri(svgBody: string): string {
  return "data:image/svg+xml," + encodeURIComponent(svgBody);
}

function icon(bg: string, inner: string): string {
  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100">` +
    `<rect width="120" height="100" rx="12" fill="${bg}"/>` +
    inner +
    `</svg>`
  );
}

// ── Switch (hub + 4 inward arrows) ─────────────────────────────────────────
const SWITCH = icon(BLUE, `
  <g fill="${W}">
    <circle cx="60" cy="50" r="7"/>
    <rect x="56" y="18" width="8" height="24" rx="3"/>
    <rect x="56" y="58" width="8" height="24" rx="3"/>
    <rect x="18" y="46" width="24" height="8" rx="3"/>
    <rect x="78" y="46" width="24" height="8" rx="3"/>
    <polygon points="60,28 54,38 66,38"/>
    <polygon points="60,72 54,62 66,62"/>
    <polygon points="32,50 42,44 42,56"/>
    <polygon points="88,50 78,44 78,56"/>
  </g>`
);

// ── Router (diamond with R) ─────────────────────────────────────────────────
const ROUTER = icon(BLUE, `
  <polygon points="60,15 95,50 60,85 25,50"
    fill="none" stroke="${W}" stroke-width="5" stroke-linejoin="round"/>
  <text x="60" y="57" text-anchor="middle"
    font-family="Arial,sans-serif" font-size="26" font-weight="700"
    fill="${W}">R</text>`
);

// ── Core Router (three stacked parallelogram layers) ────────────────────────
const ROUTER_CORE = icon(BLUE, `
  <g fill="${W}">
    <polygon points="60,18 90,32 60,46 30,32"/>
    <polygon points="60,30 90,44 60,58 30,44"/>
    <polygon points="60,42 90,56 60,70 30,56"/>
  </g>`
);

// ── Server (3 rack units with status dots) ──────────────────────────────────
const SERVER = icon(BLUE, `
  <g fill="${W}">
    <rect x="22" y="22" width="76" height="16" rx="3"/>
    <rect x="22" y="42" width="76" height="16" rx="3"/>
    <rect x="22" y="62" width="76" height="16" rx="3"/>
    <circle cx="86" cy="30" r="3" fill="${BLUE}"/>
    <circle cx="86" cy="50" r="3" fill="${BLUE}"/>
    <circle cx="86" cy="70" r="3" fill="${BLUE}"/>
  </g>`
);

// ── Firewall (brick wall + through-arrows) ───────────────────────────────────
const FIREWALL = icon(BLUE, `
  <g fill="${W}">
    <rect x="30" y="28" width="60" height="10" rx="1"/>
    <rect x="30" y="42" width="60" height="10" rx="1"/>
    <rect x="30" y="56" width="60" height="10" rx="1"/>
    <rect x="60" y="28" width="3" height="10" fill="${BLUE}"/>
    <rect x="45" y="42" width="3" height="10" fill="${BLUE}"/>
    <rect x="75" y="42" width="3" height="10" fill="${BLUE}"/>
    <rect x="60" y="56" width="3" height="10" fill="${BLUE}"/>
    <polygon points="12,50 22,44 22,56"/>
    <polygon points="108,50 98,44 98,56"/>
  </g>`
);

// ── Core Switch (cross + outward arrows) ────────────────────────────────────
const SWITCH_CORE = icon(BLUE, `
  <g fill="${W}">
    <rect x="56" y="18" width="8" height="64" rx="3"/>
    <rect x="18" y="46" width="84" height="8" rx="3"/>
    <polygon points="60,14 54,26 66,26"/>
    <polygon points="60,86 54,74 66,74"/>
    <polygon points="14,50 26,44 26,56"/>
    <polygon points="106,50 94,44 94,56"/>
  </g>`
);

// ── Cloud (cloud outline + mesh) ────────────────────────────────────────────
const CLOUD = icon(BLUE, `
  <path d="M36,68 Q22,68 22,54 Q22,42 34,40 Q34,24 52,24
           Q62,24 68,34 Q74,28 82,32 Q94,34 94,46
           Q102,48 102,58 Q102,68 90,68 Z"
    fill="none" stroke="${W}" stroke-width="4"/>
  <g fill="${W}">
    <circle cx="60" cy="54" r="4"/>
    <circle cx="44" cy="61" r="3"/>
    <circle cx="76" cy="61" r="3"/>
    <line x1="60" y1="54" x2="44" y2="61" stroke="${W}" stroke-width="2"/>
    <line x1="60" y1="54" x2="76" y2="61" stroke="${W}" stroke-width="2"/>
  </g>`
);

// ── Wireless / AP (signal arcs) ──────────────────────────────────────────────
const WIRELESS = icon(AMBER, `
  <g fill="none" stroke="${W}" stroke-width="5" stroke-linecap="round">
    <path d="M44,64 Q60,46 76,64"/>
    <path d="M32,74 Q60,38 88,74"/>
  </g>
  <g fill="${W}">
    <circle cx="60" cy="68" r="5"/>
    <rect x="20" y="80" width="80" height="5" rx="2"/>
  </g>`
);

// ── Internet / WAN (globe) ────────────────────────────────────────────────────
const INTERNET = icon(AMBER, `
  <g fill="none" stroke="${W}" stroke-width="3.5">
    <circle cx="60" cy="50" r="30"/>
    <ellipse cx="60" cy="50" rx="14" ry="30"/>
    <line x1="30" y1="50" x2="90" y2="50"/>
    <line x1="34" y1="35" x2="86" y2="35"/>
    <line x1="34" y1="65" x2="86" y2="65"/>
  </g>`
);

// ── Database (cylinder) ───────────────────────────────────────────────────────
const DATABASE = icon(AMBER, `
  <g fill="${W}">
    <ellipse cx="60" cy="28" rx="26" ry="8"/>
    <rect x="34" y="28" width="52" height="36"/>
    <ellipse cx="60" cy="64" rx="26" ry="8"/>
  </g>`
);

// ── Printer (body + paper) ────────────────────────────────────────────────────
const PRINTER = icon(AMBER, `
  <g fill="${W}">
    <rect x="38" y="18" width="44" height="26" rx="2"/>
    <rect x="22" y="40" width="76" height="30" rx="4"/>
    <rect x="38" y="70" width="44" height="14" rx="2"/>
  </g>`
);

// ── Camera (body + lens) ──────────────────────────────────────────────────────
const CAMERA = icon(AMBER, `
  <g fill="${W}">
    <rect x="16" y="36" width="88" height="46" rx="6"/>
    <rect x="38" y="26" width="24" height="14" rx="4"/>
    <circle cx="60" cy="59" r="16" fill="${AMBER}"/>
    <circle cx="60" cy="59" r="11" fill="${W}"/>
    <circle cx="60" cy="59" r="6" fill="${AMBER}"/>
    <rect x="78" y="42" width="12" height="8" rx="2" fill="${AMBER}"/>
  </g>`
);

// ── Phone (handset silhouette) ────────────────────────────────────────────────
const PHONE = icon(AMBER, `
  <path d="M32,20 L32,38 Q32,46 40,50 Q48,54 56,50
           Q60,56 64,62 Q60,68 56,72 L46,82
           Q52,88 58,84 Q80,74 88,52 Q92,42 86,36
           L76,30 Q70,26 66,32 Q62,38 66,44
           Q62,50 56,46 Q46,38 42,28 Q40,22 34,20 Z"
    fill="none" stroke="${W}" stroke-width="4"
    stroke-linejoin="round" stroke-linecap="round"/>`
);

// ---------------------------------------------------------------------------
// Public API — same signature as the original function
// ---------------------------------------------------------------------------

export function netOpsIconForDeviceType(deviceType: string): string {
  const type = deviceType.trim().toLowerCase();
  if (type.includes("firewall") || type.includes("fw") || type.includes("security"))
    return FIREWALL;
  if (type.includes("router"))
    return type.includes("core") ? ROUTER_CORE : ROUTER;
  if (type.includes("server") || type.includes("host"))
    return SERVER;
  if (type.includes("database") || type.includes("db"))
    return DATABASE;
  if (type.includes("printer"))
    return PRINTER;
  if (type.includes("camera"))
    return CAMERA;
  if (type.includes("phone"))
    return PHONE;
  if (type.includes("internet") || type.includes("wan"))
    return INTERNET;
  if (type.includes("cloud"))
    return CLOUD;
  if (type.includes("wireless") || type.includes("wifi") || type.includes("ap"))
    return WIRELESS;
  if (type.includes("layer3") || type.includes("l3") || type.includes("core"))
    return SWITCH_CORE;
  return SWITCH;
}
