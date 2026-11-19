/* What a lead told us, in one vocabulary, whichever form or tab they came from.
 *
 * Meta's form asks how they will finance it and how much they can put towards
 * it each month; TikTok's asks for a payment plan; the WhatsApp bot records the
 * track and how they want to pay. Each says it differently
 * (i_require_a_student_loan, "I require a student loan"). These fields are the
 * same for everyone, so saved messages can be aimed by rule (no Black Friday
 * offer to someone on a student loan) and the AI personalises from plain words. */

export type Funding = 'self' | 'family' | 'loan' | 'employer' | 'undecided';
export const FUNDINGS: Funding[] = ['self', 'family', 'loan', 'employer', 'undecided'];
export const FUNDING_LABEL: Record<Funding, string> = {
  self: 'Paying for themselves',
  family: 'Family or a friend is paying',
  loan: 'Needs a student loan',
  employer: 'Employer-sponsored',
  undecided: 'Not decided yet (wants to talk to an advisor)',
};

/** The columns forms use for each answer, in snake_case as the sheet reader stores them. */
const FUNDING_COLS = ['how_will_you_finance_the_program', 'how_will_you_finance_the_programme', 'funding', 'payment_plan', 'payment', 'finance'];
const BUDGET_COLS = ['how_much_can_you_put_towards_your_studies_each_month', 'monthly_budget', 'budget', 'affordability'];
const TRACK_COLS = ['track', 'programme_type'];

const pick = (f: Record<string, string>, cols: string[]) => cols.map((c) => (f[c] || '').trim()).find(Boolean) || '';
const words = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function fundingOf(raw: string): Funding | '' {
  const s = words(raw);
  if (!s) return '';
  if (/loan|lender|nsfas|finance company|capitec|manati|nedbank|student hero/.test(s)) return 'loan';
  if (/employer|company pays|work pays|sponsored by (my )?(employer|company|work)|bursary/.test(s)) return 'employer';
  if (/family|friend|parent|sponsor/.test(s)) return 'family';
  if (/fund my ?self|myself|self funded|self-funded|i will pay|i will fund|upfront|up front|installment|instalment|monthly/.test(s)) return 'self';
  if (/tbd|advisor|adviser|not sure|undecided|discuss/.test(s)) return 'undecided';
  return '';
}

/** Monthly budget in plain words ("under R1 500 a month", "can pay upfront"). */
export function budgetOf(raw: string): { band: 'under_1500' | '1500_3000' | '3000_plus' | 'upfront' | ''; label: string } {
  const s = words(raw).replace(/,/g, '');
  if (!s) return { band: '', label: '' };
  if (/upfront|up front|full|once off|lump/.test(s)) return { band: 'upfront', label: 'Can pay the fee upfront' };
  if (/under r?1500|less than r?1500|below r?1500/.test(s)) return { band: 'under_1500', label: 'Under R1 500 a month' };
  if (/r?1500 r?3000|1500 to 3000|1500 3000/.test(s)) return { band: '1500_3000', label: 'R1 500 to R3 000 a month' };
  if (/r?3000\+|r?3000 plus|more than r?3000|over r?3000|3000 per/.test(s)) return { band: '3000_plus', label: 'R3 000 or more a month' };
  return { band: '', label: raw.trim() };
}

/** How they want to pay: upfront, or monthly over N months. */
export function payPreferenceOf(raw: string): string {
  const s = words(raw);
  if (/upfront|up front|pay in full/.test(s)) return 'upfront';
  const n = /(\d+)\s*(installments?|instalments?|months?)/.exec(s);
  if (n) return `${n[1]} monthly instalments`;
  if (/installment|instalment|monthly/.test(s)) return 'monthly instalments';
  return '';
}

export function trackOf(f: Record<string, string>): 'accredited' | 'bootcamp' | '' {
  const t = words(pick(f, TRACK_COLS));
  if (/bootcamp/.test(t)) return 'bootcamp';
  if (/accredited|nqf|occupational/.test(t)) return 'accredited';
  // The WhatsApp bot's programme ids: accredited ones are named after the qualification.
  const id = words(f.programme_id || '');
  if (/^(cybersecurity analyst|cybersecurity practitioner|data science practitioner|software developer|ai software developer)$/.test(id)) return 'accredited';
  if (/^(cyber security|data science|software engineering|ai software engineering)$/.test(id)) return 'bootcamp';
  return '';
}

/** The plain profile fields for a lead (only the ones their form answered). */
export function leadProfile(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const fundRaw = pick(f, FUNDING_COLS);
  const funding = fundingOf(fundRaw);
  if (funding) { out.funding = funding; out.funding_said = FUNDING_LABEL[funding]; }
  const budget = budgetOf(pick(f, BUDGET_COLS));
  if (budget.band) out.monthly_budget = budget.label;
  if (budget.band === 'upfront' && !out.funding) { out.funding = 'self'; out.funding_said = FUNDING_LABEL.self; }
  const pay = payPreferenceOf(f.payment_plan || '') || payPreferenceOf(fundRaw) || (budget.band === 'upfront' ? 'upfront' : '');
  if (pay) out.pay_preference = pay;
  const track = trackOf(f);
  if (track) out.track = track;
  return out;
}
