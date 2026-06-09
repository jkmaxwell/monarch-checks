// Map a recipient spelling variant to its canonical merchant name. The map is
// user-editable (chrome.storage 'normalizationMap'); seeded with known typos.
export function normalize(name, map) {
  const n = String(name == null ? '' : name).trim();
  if (!map) return n;
  for (const [variant, canonical] of Object.entries(map)) {
    if (variant.toLowerCase() === n.toLowerCase()) return canonical;
  }
  return n;
}
