/* Words for the ear.
 *
 * Narration is written for reading ("R 37 499", "NQF 5", "Mon–Thu 10:00–16:00",
 * "30%") and a voice reads symbols badly: "R 37 499" comes out as "R thirty
 * seven four nine nine". Before a script goes to the voice it becomes what a
 * South African presenter would say: "thirty-seven thousand, four hundred and
 * ninety-nine rand", "N Q F level five", "Monday to Thursday, ten to four",
 * "thirty percent". The screen keeps the written form. */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
  if (!h) return rest;
  return r ? `${ONES[h]} hundred and ${rest}` : `${ONES[h]} hundred`;
}

/** 37499 → "thirty-seven thousand, four hundred and ninety-nine" (British/South African "and"). */
export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberWords(-n)}`;
  const whole = Math.floor(n);
  if (whole < 1000) return under1000(whole);
  const parts: string[] = [];
  const units: [number, string][] = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1000, 'thousand']];
  let rest = whole;
  for (const [size, name] of units) {
    if (rest >= size) { parts.push(`${under1000(Math.floor(rest / size))} ${name}`); rest %= size; }
  }
  if (rest) parts.push(rest < 100 ? `and ${under1000(rest)}` : under1000(rest));
  return parts.join(', ').replace(/, and /, ' and ');
}

const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** 15 → "fifteenth", 21 → "twenty-first", 30 → "thirtieth". */
export function ordinalWords(n: number): string {
  const w = numberWords(n);
  return w.replace(/([a-z]+)$/, (last) => ORDINAL[last] || (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`));
}

/** 2027 → "twenty twenty-seven", 2005 → "two thousand and five", 1999 → "nineteen ninety-nine". */
export function yearWords(y: number): string {
  if (y >= 2000 && y < 2010) return numberWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (!lo) return `${numberWords(hi)} hundred`;
  return `${numberWords(hi)} ${lo < 10 ? `oh ${numberWords(lo)}` : numberWords(lo)}`;
}

const MONTHS: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August',
  sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December',
};
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const monthName = (m: string) => MONTHS[m.toLowerCase().slice(0, m.toLowerCase().startsWith('sept') ? 4 : 3)] || m;

/** "R 37 499", "R37,499.00", "R1 500" → the amount as a number (cents dropped when zero). */
function amount(raw: string): number | null {
  const s = raw.replace(/[\s ,]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function rand(raw: string): string {
  const n = amount(raw);
  if (n === null) return raw;
  const whole = Math.floor(n);
  const cents = Math.round((n - whole) * 100);
  return `${numberWords(whole)} rand${cents ? ` and ${numberWords(cents)} cents` : ''}`;
}

const DAYS: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function clock(h: string, m: string): string {
  const hour = Number(h);
  const min = Number(m);
  const twelve = hour % 12 || 12;
  const word = numberWords(twelve);
  if (!min) return hour === 12 ? 'midday' : word;
  if (min === 30) return `half past ${word}`;
  return `${word} ${min < 10 ? `oh ${numberWords(min)}` : numberWords(min)}`;
}

/** Acronyms said letter by letter, and words a voice tends to mispronounce. */
const SAY: [RegExp, string][] = [
  [/\bSAST\b/g, 'South African time'],
  [/\bHTML\s?5\b/g, 'H T M L five'],
  [/\bHTML\b/g, 'H T M L'],
  [/\bCSS\b/g, 'C S S'],
  [/\bAPIs\b/g, 'A P Is'],
  [/\bAPI\b/g, 'A P I'],
  [/\bUML\b/g, 'U M L'],
  [/\bML\b/g, 'M L'],
  [/\bBI\b/g, 'B I'],
  [/\bIT\b/g, 'I T'],
  [/\bPDF\b/g, 'P D F'],
  [/\bFAQs?\b/g, 'questions'],
  [/\bNSFAS\b/g, 'N S FAS'],
  [/\bNQF\b/g, 'N Q F'],
  [/\bSAQA\b/g, 'S A Q A'],
  [/\bQCTO\b/g, 'Q C T O'],
  [/\bMICT\s*SETA\b/gi, 'M I C T SETA'],
  [/\bBANKSETA\b/g, 'BANK SETA'],
  [/\bSOC\b/g, 'S O C'],
  [/\bSIEM\b/g, 'S I E M'],
  [/\bGRC\b/g, 'G R C'],
  [/\bRPL\b/g, 'R P L'],
  [/\bUI\/UX\b/g, 'U I and U X'],
  [/\bAI\b/g, 'A I'],
  [/\bSQL\b/g, 'sequel'],
  [/\bMLOps\b/g, 'M L ops'],
  [/\bCV\b/g, 'C V'],
  [/\bID\b/g, 'I D'],
  [/\bB-BBEE\b/g, 'B triple B E E'],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
];

/** The script as a South African presenter would say it. */
export function forSpeech(text: string): string {
  let s = text;
  // Rand ranges first: "R1 500 - R3 000" → "one thousand five hundred to three thousand rand".
  s = s.replace(/\bR\s?(\d{1,3}(?:[\s\u00a0,]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:-|–|to)\s*R\s?(\d{1,3}(?:[\s\u00a0,]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g, (_, a, b) => `${numberWords(amount(a) ?? 0)} to ${rand(b)}`);
  // Rand amounts: "R 37 499", "R37,499.00", "R500" (a lone "R" before a number is the currency).
  s = s.replace(/\bR\s?(\d{1,3}(?:[\s\u00a0,]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?=\b|[^\d])/g, (_, a) => rand(a));
  // "30%" → "thirty percent".
  s = s.replace(/(\d+(?:\.\d+)?)\s?%/g, (_, a) => `${numberWords(Number(a))} percent`);
  // Times "10:00–16:00" → "ten to four"; "23:59" → "eleven fifty-nine".
  s = s.replace(/\b(\d{1,2}):(\d{2})\s?(?:-|–|to)\s?(\d{1,2}):(\d{2})\b/g, (_, h1, m1, h2, m2) => `${clock(h1, m1)} to ${clock(h2, m2)}`);
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => clock(h, m));
  // Day ranges "Mon–Thu" → "Monday to Thursday".
  s = s.replace(/\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\s?(?:-|–|to)\s?(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b/gi, (_, a, b) => `${DAYS[a.toLowerCase()]} to ${DAYS[b.toLowerCase()]}`);
  // Month ranges "12–18 months" → "twelve to eighteen months".
  s = s.replace(/\b(\d{1,3})\s?(?:-|–)\s?(\d{1,3})\s+(months?|weeks?|days?|years?|hours?)\b/g, (_, a, b, unit) => `${numberWords(Number(a))} to ${numberWords(Number(b))} ${unit}`);
  // "3 x R 15 278" already became words; "12 x" → "twelve payments of".
  s = s.replace(/\b(\d{1,2})\s?[x×]\s?/g, (_, a) => `${numberWords(Number(a))} payments of `);
  for (const [re, said] of SAY) s = s.replace(re, said);
  // An ID is read digit by digit: "SAQA ID 118708" → "S A Q A I D one one eight seven oh eight".
  s = s.replace(/\bI D(\s*(?:number|no\.?)?\s*(?:is\s*)?:?\s*)(\d{3,})\b/gi, (_, gap, d: string) => `I D ${d.split('').map((c) => (c === '0' ? 'oh' : ONES[Number(c)])).join(' ')}`);
  // "R 3 997/month", "x/mo", "p/m" → "a month" (never "rand or month").
  s = s.replace(/\s?(?:\/\s?|\bper\s)(month|mo|mth|week|wk|year|yr|annum)\b/gi, (_, u) => ` a ${/^w/i.test(u) ? 'week' : /^(y|a)/i.test(u) ? 'year' : 'month'}`).replace(/\bp\/m\b/gi, 'a month');
  s = s.replace(/\b24\/7\b/g, 'twenty-four seven');
  // Dates: "15 December 2026" → "the fifteenth of December, twenty twenty-six"; "December 15" → "December the fifteenth".
  s = s.replace(new RegExp(`\\b(?:[Tt]he\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+((?:19|20)\\d{2})\\b)?`, 'g'), (_, d, m, y) => `the ${ordinalWords(Number(d))} of ${monthName(m)}${y ? `, ${yearWords(Number(y))}` : ''}`);
  s = s.replace(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s?(?:,\\s?)?\\d{3})(?:,?\\s+((?:19|20)\\d{2})\\b)?`, 'g'), (_, m, d, y) => `${monthName(m)} the ${ordinalWords(Number(d))}${y ? `, ${yearWords(Number(y))}` : ''}`);
  // A month and a year: "January 2027" → "January twenty twenty-seven".
  s = s.replace(new RegExp(`\\b${MONTH}\\s+((?:19|20)\\d{2})\\b`, 'g'), (_, m, y) => `${monthName(m)} ${yearWords(Number(y))}`);
  // Years on their own: "since 2019" → "since twenty nineteen".
  s = s.replace(/\b((?:19|20)\d{2})\b(?![\s,.]?\d)/g, (_, y) => yearWords(Number(y)));
  // Ordinals: "1st", "22nd".
  s = s.replace(/\b(\d{1,3})(?:st|nd|rd|th)\b/g, (_, n) => ordinalWords(Number(n)));
  // "8+" → "eight plus"; ranges "1-4" / "1–4" → "one to four".
  s = s.replace(/\b(\d+)\+/g, '$1 plus');
  s = s.replace(/\b(\d{1,3}(?:[\s\u00a0,]\d{3})*)\s?[-–]\s?(\d{1,3}(?:[\s\u00a0,]\d{3})*)\b/g, '$1 to $2');
  // Every other number as words: "1 000" → "one thousand", "12" → "twelve", "2.5" → "two point five";
  // a number that starts with 0 (a phone number, a code) is read digit by digit.
  const digits = (d: string) => d.replace(/\D/g, '').split('').map((c) => (c === '0' ? 'oh' : ONES[Number(c)])).join(' ');
  s = s.replace(/(?:\+27[\s-]?|\b0)\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, (d) => (d.startsWith('+27') ? `plus two seven ${digits(d.slice(3))}` : digits(d)));
  s = s.replace(/\b(?!0\d)(\d{1,3}(?:[\u00a0,]\d{3})+|\d{1,3}(?: \d{3})+(?!\d)|\d+)(?:\.(\d+))?\b/g, (_, whole, frac) => {
    const n = Number(String(whole).replace(/[\s\u00a0,]/g, ''));
    return `${numberWords(n)}${frac ? ` point ${String(frac).split('').map((c) => ONES[Number(c)]).join(' ')}` : ''}`;
  });
  s = s.replace(/\b0\d+\b/g, digits);
  // "a eight thousand" → "an eight thousand".
  s = s.replace(/\b([Aa]) (eight|eleven|eighteen|eighty)\b/g, '$1n $2');
  // Ampersands and slashes read as words.
  s = s.replace(/\s&\s/g, ' and ').replace(/(\w)\/(\w)/g, '$1 or $2');
  return s.replace(/\s+/g, ' ').trim();
}
