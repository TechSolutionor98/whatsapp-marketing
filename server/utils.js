// Normalize a phone number to WhatsApp's digits-only form (country code + number).
export function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim().replace(/[^\d]/g, '');
  if (!p) return null;
  // Strip a leading "00" international prefix.
  if (p.startsWith('00')) p = p.slice(2);
  return p;
}

export function phoneToJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

export function jidToPhone(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

// Resolve spintax: "{Hi|Hello|Hey}" -> one random option. Supports nesting.
export function spin(text) {
  const re = /\{([^{}]*)\}/;
  let out = text;
  let guard = 0;
  while (re.test(out) && guard++ < 100) {
    out = out.replace(re, (_, group) => {
      const options = group.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return out;
}

// Replace {{name}} style variables from a contact, then resolve spintax.
export function renderTemplate(body, contact = {}) {
  const firstName = (contact.name || '').trim().split(/\s+/)[0] || 'there';
  const vars = {
    name: contact.name || 'there',
    first_name: firstName,
    phone: contact.phone || '',
  };
  let out = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : ''
  );
  return spin(out).trim();
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Casual, varied warm-up lines (spintax + {{first_name}}). Deliberately NOT marketing —
// the goal is natural-looking, friendly activity on the number.
export const WARMUP_POOL = [
  '{Hey|Hi|Hello} {{first_name}}! {How are you|How have you been|How is it going}? 🙂',
  '{Hi|Hey} {{first_name}}, {how is your week going|hope your week is going well|how are things}?',
  '{Morning|Hey|Hi} {{first_name}}! {Hope you have a great day|Wishing you a good day ahead} ✨',
  '{Hey|Hi} {{first_name}}, {long time no talk|it has been a while}! {How are you doing|What is new}?',
  '{Hello|Hey} {{first_name}} 👋 {just checking in|thought of you today}, {hope all is well|hope you are good}!',
  '{Hi|Hey} {{first_name}}! {Did you have a good weekend|How was your weekend|Any plans this weekend}?',
  '{Hey|Hi} {{first_name}}, {hope you are staying well|hope you are keeping healthy} {these days|lately} 🙏',
  '{Hello|Hi} {{first_name}}! {How is family|How is everyone at home|Hope the family is well}?',
  '{Hey|Hi} {{first_name}}, {what is keeping you busy lately|how is work going|how is everything on your side}?',
  '{Hi|Hey} {{first_name}}! {Just wanted to say hi|Saying hello} — {take care|talk soon|catch up soon}! 🙂',
];

// Natural replies for the other number to send back (mutual warm-up conversations).
export const WARMUP_REPLIES = [
  '{Hey|Hi}! {I am good|Doing well|All good here|Pretty good} {thanks|thanks for asking} 🙂 {You|And you}?',
  '{Good|Great|Not bad} {thanks|thank you}! {How about you|What about you|You}?',
  '{Hi|Hey} 👋 {all good on my side|everything is fine here|doing great}, {hope you too|hope the same for you}!',
  '{Haha|Ah} {yeah|yes} {all good|going well}! {Been busy but fine|Keeping busy|Can not complain} 😄',
  '{Thanks|Thank you} for checking in! {I am well|Doing fine|All good} — {talk soon|let us catch up soon}.',
  '{Hey|Hi}! {Good to hear from you|Nice to hear from you} 🙂 {I am doing well|Things are good}.',
  '{Yeah|Yes} {same here|likewise}! {Hope you have a good one|Have a great day} 👍',
];

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Current HH:MM in a given IANA timezone, plus a YYYY-MM-DD date key.
export function nowInTz(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [{ value: h }, , { value: m }] = fmt.formatToParts(new Date());
  return { hhmm: `${h}:${m}`, date: dateFmt.format(new Date()) };
}

export function withinWindow(hhmm, start, end) {
  // Supports windows that do not cross midnight (e.g. 09:00-21:00).
  return hhmm >= start && hhmm <= end;
}
