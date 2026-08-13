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

// Size lines are stripped ONLY when the slot's own sizes field holds them —
// otherwise the merged render (description + sizes) would print sizes twice.
// With the sizes field blank, whatever is typed in the description stays put,
// so sizes can be written inline there instead (Matt's Nemacolin flow).
function cleanDescription(desc, sizes) {
  if (!desc) return '';
  const sizesFieldHasValue = String(sizes == null ? '' : sizes).trim() !== '';
  return String(desc)
    .replace(/ \/ /g, '\n')
    .split('\n')
    .filter((line) => {
      if (!sizesFieldHasValue) return true;
      const l = line.trim();
      if (/^\s*(?:XXS|XS|S|M|L|XL|XXL|XXXL|3XL|2XL)\s*:\s*\d+(\s*[-,]\s*(?:XXS|XS|S|M|L|XL|XXL|XXXL|3XL|2XL)\s*:\s*\d+)*\s*$/i.test(l)) return false;
      if (/^[A-Za-z\s/]+\s*[-–]\s*(?:XXS|XS|S|M|L|XL|XXL|XXXL|3XL|2XL)\s*:\s*\d+/i.test(l)) return false;
      return true;
    })
    .join('\n')
    .trim();
}


// Sum a sizes string ("S: 2 - M: 8 - L: 10") into a total quantity — used when a
// line item has sizes but no explicit quantity (mirrors autoQtyFromSizes).
function qtyFromSizes(sizesVal) {
  const matches = String(sizesVal || '').match(/:\s*(\d+)/g);
  if (!matches) return 0;
  return matches.reduce((t, m) => t + (parseInt(m.replace(/[^\d]/g, ''), 10) || 0), 0);
}

module.exports = { formatAddrHS, parseShipDate, cleanDescription, qtyFromSizes, HS_STATES };
