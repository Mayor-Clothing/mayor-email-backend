// Ported verbatim from mayor-tools (the original browser invoice builder) so the
// backend's Hermes PDFs use the SAME formatting rules that were working there.
// Three transforms the deal->payload mapping must apply:
//   - formatAddrHS:   HubSpot address string -> proper multi-line address
//   - parseShipDate:  raw date -> "Monday, July 6, 2026"
//   - cleanDescription: line-item description cleanup (" / " -> newline; drop
//                       embedded size lines ONLY when the separate sizes field
//                       holds them, so sizes can be written inline instead)

const HS_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];

const formatAddrHS = (addr) => {
  if (!addr) return '';
  // Slash-separated (most common HubSpot format)
  if (addr.includes(' / ')) {
    return addr.split(' / ').map((s) => s.trim()).filter(Boolean).join('\n');
  }
  // Already has newlines — pass through
  if (addr.includes('\n')) return addr.replace(/\n+/g, '\n').trim();

  // Comma-separated — intelligently split into lines
  const parts = addr.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const isStateZip = (p) => /^[A-Z]{2}\s+\d{5}/.test(p) || HS_STATES.some((s) => p.startsWith(s + ' ') && /\d{5}/.test(p));
    const lines = [];
    let i = 0;
    while (i < parts.length) {
      const part = parts[i];
      const nxt = parts[i + 1] || '';
      if (isStateZip(part) && lines.length > 0) {
        lines[lines.length - 1] += ', ' + part;
        if (/^\(?\d{3}\)?/.test(nxt)) { i++; lines.push(parts[i]); }
      } else if (isStateZip(nxt)) {
        lines.push(part + ', ' + nxt);
        i++;
        if (parts[i + 1] && /^\(?\d{3}\)?/.test(parts[i + 1])) { i++; lines.push(parts[i]); }
      } else {
        lines.push(part);
      }
      i++;
    }
    const final = [];
    lines.forEach((line) => {
      const m = line.match(/\s([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
      if (m) { final.push(line.substring(0, m.index).trim()); final.push(m[1].trim()); } else final.push(line);
    });
    return final.filter(Boolean).join('\n');
  }

  // Single-line fallback
  return addr
    .replace(/([a-z])([A-Z])/g, '$1\n$2')
    .replace(/([a-zA-Z])(\d{3,})/g, '$1\n$2')
    .replace(/([A-Z]{2})\s+(\d{5}[-\d]*)\s*\(/g, '$1 $2\n(')
    .replace(/([A-Z]{2})\s+(\d{5}[-\d]*)\s+/g, '$1 $2\n')
    .replace(/\s+([a-zA-Z0-9._%+\-]+@)/g, '\n$1')
    .replace(/\n+/g, '\n').trim();
};

// HubSpot's shipping/billing phone fields store E.164 ("+17244953300") --
// render it the way Matt's addresses always have: "(724) 495-3300".
function formatPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return String(raw).trim();
}

// Builds the same "Company \n Attn: Contact \n Street \n City, ST Zip \n Phone"
// block formatAddrHS produces from free text, but from ten discrete HubSpot
// fields instead of guessing at line breaks. `prefix` is 'shipping_address_' or
// 'billing_address_'; props holds the raw HubSpot property values.
// Billing's state field is named "stateprov" in HubSpot; shipping's is "state".
const stateKey = (prefix) => (prefix === 'billing_address_' ? 'stateprov' : 'state');

function formatStructuredAddr(props, prefix) {
  const val = (key) => String(props[prefix + key] || '').trim();
  const lines = [];
  const company = val('receiver_or_company_name');
  const contact = val('contact_name');
  if (company) lines.push(company);
  if (contact) lines.push('Attn: ' + contact);
  ['address_1', 'address_2', 'address_3'].forEach((key) => { const v = val(key); if (v) lines.push(v); });
  const cityStateZip = [[val('city'), val(stateKey(prefix))].filter(Boolean).join(', '), val('postal_code')].filter(Boolean).join(' ');
  if (cityStateZip) lines.push(cityStateZip);
  const country = val('country');
  if (country) lines.push(country);
  const phone = formatPhone(val('phone_number'));
  if (phone) lines.push(phone);
  return lines.join('\n');
}

// True if any of the ten structured fields for this prefix have a value —
// signals "this deal has been migrated to structured address fields."
function hasStructuredAddr(props, prefix) {
  return ['receiver_or_company_name', 'contact_name', 'address_1', 'address_2', 'address_3', 'city', stateKey(prefix), 'postal_code', 'country', 'phone_number']
    .some((key) => String(props[prefix + key] || '').trim());
}

// Product #1's description used to be one free-text field; Matt broke it into
// discrete fields (Print/Icons, Colorway, Embroidery A, Embroidery B, and a
// Custom Woven Labels & Hang Tags note tied to that fee). Sizes stays a
// separate field/column entirely (unchanged, own "Sizes: " line). Embroidery
// A/B hold placement + details together ("(Left Chest): Shield Logo ...")
// since placement varies per order -- the fixed "Embroidery " label is
// prepended here, not baked into the field.
const DESC1_FIELDS = ['description_printicons_1', 'description_colorway_1', 'description_embroidery_a_1', 'description_embroidery_b_1', 'description_custom_woven_labels__hang_tags'];

function hasStructuredDescription1(props) {
  return DESC1_FIELDS.some((key) => String(props[key] || '').trim());
}

function formatStructuredDescription1(props) {
  const val = (key) => String(props[key] || '').trim();
  const lines = [];
  const printicons = val('description_printicons_1');
  const colorway = val('description_colorway_1');
  const embA = val('description_embroidery_a_1');
  const embB = val('description_embroidery_b_1');
  const wovenLabels = val('description_custom_woven_labels__hang_tags');
  if (printicons) lines.push('Icons: ' + printicons);
  if (colorway) lines.push('Colorway: ' + colorway);
  if (embA) lines.push('Embroidery ' + embA);
  if (embB) lines.push('Embroidery ' + embB);
  if (wovenLabels) lines.push('Custom Woven Labels & Hang Tags: ' + wovenLabels);
  return lines.join('\n');
}

function parseShipDate(raw) {
  if (!raw || raw === '--') return '';
  raw = String(raw).replace(/\s*\(.*?\)\s*$/, '').trim();
  if (/[A-Za-z]/.test(raw) && raw.length > 6) return raw.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const d = new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (/^\d{10,13}$/.test(raw.trim())) {
    const d = new Date(Number(raw.trim()) * (raw.trim().length === 10 ? 1000 : 1));
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  return raw.trim();
}

// Description is passed through as typed, with HubSpot's " / " separator turned
// into line breaks. Nothing is stripped: sizes written inline in the description
// must survive, because the sheet mirrors HubSpot rather than deriving from it.
function cleanDescription(desc) {
  if (!desc) return '';
  return String(desc).replace(/ \/ /g, '\n').trim();
}


// Sum a sizes string ("S: 2 - M: 8 - L: 10") into a total quantity — used when a
// line item has sizes but no explicit quantity (mirrors autoQtyFromSizes).
function qtyFromSizes(sizesVal) {
  const matches = String(sizesVal || '').match(/:\s*(\d+)/g);
  if (!matches) return 0;
  return matches.reduce((t, m) => t + (parseInt(m.replace(/[^\d]/g, ''), 10) || 0), 0);
}

module.exports = { formatAddrHS, formatStructuredAddr, hasStructuredAddr, hasStructuredDescription1, formatStructuredDescription1, parseShipDate, cleanDescription, qtyFromSizes, HS_STATES };
