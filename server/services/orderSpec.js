// What the customer has asked for, read out of their conversation. Pure and deterministic (rules, no model, no database), so the server,
// the browser demo and the tests all agree, and reading the same messages twice always gives the same answer.
//
// It only reports what the customer actually wrote. A field they never mentioned stays empty (the order screen shows it as awaiting
// confirmation); nothing is guessed. When the customer changes their mind the newest message wins for the CURRENT specification, and
// every earlier value stays in that field's history with the message and time it came from. The messages themselves are never edited.
//
// Messages are in the shape the API serves: { id, text, at, attachment, scan, payment }.

const COLOURS = ['white', 'blue', 'pink', 'red', 'green', 'yellow', 'purple', 'gold', 'golden', 'silver', 'orange', 'black', 'brown', 'teal', 'lavender', 'peach', 'maroon', 'navy'];
const COLOUR = `(${COLOURS.join('|')})`;
const FLAVOUR = '((?:dark |milk |white )?chocolate|vanilla|pistachio|rose|red velvet|strawberry|butterscotch|mango|coffee|lemon|black forest|caramel|oreo|blueberry)';
const UNIT = '(kg|kgs|kilo|kilos|dozen|pcs|pieces|boxes)';
const CORRECTION = /\b(actually|instead|change[ds]?|sorry|oops|correction|make it|replace|rather)\b/i;
const QUOTE = /(?:write|writing|written|say|says|print|put|message|text|wording|name)\b[^"“”\n]{0,40}["“”]([^"“”\n]{1,80})["“”]/i;
const REQUEST = new RegExp(`\\b(?:i\\s*(?:want|need|would like|will take)|i'?d like|looking for|please make|can i (?:get|order|have))\\s+(?:a|an|the|some)?\\s*(\\d+(?:\\.\\d+)?)?\\s*${UNIT}?\\s*([a-z][a-z\\- ]{2,60}?)(?=\\s+(?:for|by|on|with|in|as|please)\\b|[.,!?\\n]|$)`, 'i');
const RECOUNT = new RegExp(`\\b(?:make it|make that|change (?:it |that |the (?:order|quantity) )?to|actually)\\s+(?:to\\s+)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\b`, 'i');
const DECOR = /\b(?:((?:edible|fresh|gold|golden|silver|pink|blue|white|red|green|colou?rful)\s+)?(toppers?|sprinkles|flowers|candles?|ribbon|pearls|gold leaf))\b/gi;
const WHEN = /\b(?:by|before|on)\s+((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon)(?:\s+(?:tomorrow|today|on \w+day))?|tomorrow(?:\s+(?:morning|afternoon|evening))?|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)/i;
const SPECIAL = [
  /\b(no nuts|nut[- ]free|eggless|egg[- ]free|sugar[- ]free|gluten[- ]free|vegan|jain|less sweet|allerg\w*)\b/i,
  /\bnames? on (?:the )?(?:tags?|cards?|boxes)\b/i,
  /\bhand[- ]?written card\b/i,
  /\bgift[- ]?wrap\w*\b/i,
];

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sentences = (t) => String(t ?? '').split(/(?<=[.!?\n])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const clean = (v) => v.replace(/\s+/g, ' ').trim();

// 'reference' = a picture of what the customer wants; 'payment' = a payment screenshot (or already handled as one);
// null = not sorted yet (still being read, or the reading failed), so it is not shown as either.
export function imageKind(m) {
  if (!m?.attachment) return null;
  if (m.payment || ['filed', 'review', 'duplicate'].includes(m.scan?.state)) return 'payment';
  if (m.scan?.state === 'not_payment') return 'reference';
  return null;
}

function readMessage(m) {
  const out = [];
  const text = m.text ?? '';
  if (!text.trim()) return out;
  const fix = CORRECTION.test(text);
  const put = (key, value) => value && out.push({ key, value, correction: fix });
  const req = text.match(REQUEST);
  if (req) {
    const [, n, unit, product] = req;
    const prod = clean(product).replace(/\b(please|today|tomorrow)$/i, '').trim();
    if (prod) put('product', cap(prod));
    if (n) put('quantity', unit ? `${n} ${/^kilos?$|^kgs?$/i.test(unit) ? 'kg' : unit.toLowerCase()}` : n);
  } else {
    const re = text.match(RECOUNT);
    if (re) put('quantity', re[2] ? `${re[1]} ${/^kilos?$|^kgs?$/i.test(re[2]) ? 'kg' : re[2].toLowerCase()}` : re[1]);
  }
  const when = text.match(WHEN); // kept as the customer worded it: Conversa does not turn it into a date and never sets the order's deadline from it
  if (when) put('deadline', clean(when[1]));
  const q = text.match(QUOTE);
  if (q) put('cakeMessage', clean(q[1]));
  for (const s of sentences(text)) {
    if (/\b(icing|frosting|lettering|piping|writing)\b/i.test(s)) {
      const found = [...s.matchAll(new RegExp(`\\b${COLOUR}\\b`, 'gi'))].map((x) => x[1].toLowerCase().replace('golden', 'gold'));
      if (found.length) put('icingColour', cap(found[found.length - 1]));
    }
    if (/\b(flavou?r|ganache|filling|sponge)\b/i.test(s)) {
      const f = s.match(new RegExp(`\\b${FLAVOUR}(?:\\s*(?:,|and|&)\\s*${FLAVOUR})?(?:\\s+(ganache|filling|sponge))?`, 'i'));
      if (f) put('flavour', cap(clean([f[1], f[2] && `and ${f[2]}`, f[3]].filter(Boolean).join(' ').toLowerCase())));
    }
    if (!/\b(no|without|don'?t)\s+\w*\s*(topper|sprinkles|flowers|candles?|ribbon|pearls)/i.test(s)) {
      for (const d of s.matchAll(DECOR)) put('decoration', clean(`${d[1] ?? ''}${d[2]}`.toLowerCase()).replace(/^golden/, 'gold'));
    }
    if (SPECIAL.some((re) => re.test(s))) put('specialRequest', clean(s).slice(0, 140));
  }
  return out;
}

const LABEL = { product: 'Product', quantity: 'Quantity', cakeMessage: 'Message on the cake', icingColour: 'Icing colour', flavour: 'Flavour', deadline: 'Deadline (customer\'s words)' };

export function extractOrderSpec(messages) {
  // Only what the CUSTOMER wrote counts: the baker's prices, promises and suggestions are never read as the customer's instructions.
  const msgs = messages.filter((m) => m.from !== 'business').sort((a, b) => new Date(a.at) - new Date(b.at));
  const single = Object.fromEntries(Object.keys(LABEL).map((k) => [k, []]));
  const lists = { decoration: [], specialRequest: [] };
  for (const m of msgs) {
    for (const f of readMessage(m)) {
      const entry = { value: f.value, at: m.at, messageId: m.id, correction: f.correction };
      if (single[f.key]) { const last = single[f.key].at(-1); if (!last || last.value.toLowerCase() !== f.value.toLowerCase()) single[f.key].push(entry); }
      else if (!lists[f.key].some((x) => x.value.toLowerCase() === f.value.toLowerCase())) lists[f.key].push(entry);
    }
  }
  const field = (key) => {
    const h = single[key]; const cur = h.at(-1) ?? null;
    return { key, label: LABEL[key], value: cur?.value ?? null, at: cur?.at ?? null, messageId: cur?.messageId ?? null, status: cur ? 'from_customer' : 'awaiting', changed: h.length > 1,
      history: h.map((e, i) => ({ value: e.value, at: e.at, messageId: e.messageId, current: i === h.length - 1, correction: e.correction })) };
  };
  return {
    fields: Object.keys(LABEL).map(field),
    decorations: lists.decoration.map(({ value, at, messageId }) => ({ value, at, messageId })),
    specialRequests: lists.specialRequest.map(({ value, at, messageId }) => ({ value, at, messageId })),
    referenceImages: msgs.filter((m) => imageKind(m) === 'reference').map((m) => ({ messageId: m.id, at: m.at, url: m.attachment.url, contentType: m.attachment.contentType ?? null, caption: m.text ?? null })),
    unsortedImages: msgs.filter((m) => m.attachment && imageKind(m) === null).map((m) => ({ messageId: m.id, at: m.at, url: m.attachment.url, state: m.scan?.state ?? null })),
  };
}
