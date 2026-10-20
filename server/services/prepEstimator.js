// Estimates preparation time from configurable rules: base + perUnit * quantity (+ customisation allowance).
// Results are ESTIMATES from developer/seller-defined rules, not learned from history.
export function estimatePrep({ item, quantity = 1, customisation = null }, settings) {
  const text = String(item ?? '').toLowerCase();
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  // Longest matching keyword wins, so "cupcake" is not captured by a "cake" rule regardless of rule order.
  let rule = null;
  let best = 0;
  for (const r of settings.prepRules ?? []) {
    for (const k of r.keywords) if (text.includes(k.toLowerCase()) && k.length > best) { rule = r; best = k.length; }
  }
  if (!rule) return { minutes: null, isEstimate: true, basis: 'no_matching_rule', ruleName: null };

  let minutes = rule.baseMinutes + rule.perUnitMinutes * qty;
  if (customisation) minutes += settings.customisationMinutes ?? 0;
  minutes = Math.ceil(minutes / 5) * 5; // round up to 5 minutes
  return { minutes, isEstimate: true, basis: 'rule', ruleName: rule.name };
}
