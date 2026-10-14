/**
 * Transparent, local, rule-based categorization. No AI service.
 *
 * Order of precedence (first match wins):
 *   1. Household merchant rules (created when you confirm "always use this category") — longest pattern first.
 *   2. Built-in merchant aliases (well-known US chains).
 *   3. Receipt line items (e.g. "UNLEADED", "GALLONS" → Fuel; "RX" → Health and pharmacy).
 *   4. Keywords in the merchant name ("pizza", "pharmacy", "parking", …).
 *   5. Uncategorized.
 *
 * Limits: rules only know the merchant name and receipt text. A big-box store sells groceries, clothes and
 * electronics, so its default category is a best guess; the user can always override, and repeated corrections
 * offer to create a household rule. Add aliases/keywords below to extend the engine.
 */
import { normalizeMerchant } from './expenseQuery';
import { UNCATEGORIZED_ID } from './categories';
import type { MerchantRule } from './types';

export interface Classification {
  categoryId: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /** Canonical display name when a known merchant was recognized. */
  canonicalName?: string;
}

interface Alias {
  pattern: string; // normalized substring, matched on word boundaries
  name: string;
  categoryId: string;
  fuel?: boolean; // fuel station: may be snacks if the receipt has no fuel lines
}

const A = (categoryId: string, entries: Array<[string, string] | [string, string, true]>): Alias[] =>
  entries.map(([pattern, name, fuel]) => ({ pattern, name, categoryId, fuel: fuel === true }));

export const MERCHANT_ALIASES: readonly Alias[] = [
  ...A('cat-groceries', [
    ['kroger', 'Kroger'], ['meijer', 'Meijer'], ['whole foods', 'Whole Foods'], ['trader joe', "Trader Joe's"], ['aldi', 'Aldi'],
    ['costco', 'Costco'], ['sams club', "Sam's Club"], ['safeway', 'Safeway'], ['publix', 'Publix'], ['heb', 'H-E-B'],
    ['wegmans', 'Wegmans'], ['albertsons', 'Albertsons'], ['food lion', 'Food Lion'], ['giant eagle', 'Giant Eagle'],
    ['hy vee', 'Hy-Vee'], ['sprouts', 'Sprouts'], ['fresh thyme', 'Fresh Thyme'], ['busch s', "Busch's"], ['hiller s', "Hiller's"],
    ['patel brothers', 'Patel Brothers'], ['india bazaar', 'India Bazaar'], ['h mart', 'H Mart'], ['lidl', 'Lidl'], ['spartan', 'Spartan'],
    ['instacart', 'Instacart'], ['walmart', 'Walmart'], ['wal mart', 'Walmart'], ['target', 'Target'],
  ]),
  ...A('cat-fuel', [
    ['shell', 'Shell', true], ['speedway', 'Speedway', true], ['marathon', 'Marathon', true], ['bp', 'BP', true], ['mobil', 'Mobil', true],
    ['exxon', 'Exxon', true], ['sunoco', 'Sunoco', true], ['citgo', 'Citgo', true], ['chevron', 'Chevron', true], ['valero', 'Valero', true],
    ['circle k', 'Circle K', true], ['sheetz', 'Sheetz', true], ['wawa', 'Wawa', true], ['quiktrip', 'QuikTrip', true], ['phillips 66', 'Phillips 66', true],
    ['costco gas', 'Costco Gas', true], ['meijer gas', 'Meijer Gas', true], ['kroger fuel', 'Kroger Fuel', true], ['murphy usa', 'Murphy USA', true],
  ]),
  ...A('cat-coffee', [
    ['starbucks', 'Starbucks'], ['dunkin', "Dunkin'"], ['tim hortons', 'Tim Hortons'], ['biggby', 'Biggby Coffee'], ['caribou', 'Caribou Coffee'],
    ['peet s', "Peet's Coffee"], ['dutch bros', 'Dutch Bros'], ['krispy kreme', 'Krispy Kreme'], ['7 eleven', '7-Eleven'],
  ]),
  ...A('cat-restaurants', [
    ['mcdonald', "McDonald's"], ['chipotle', 'Chipotle'], ['panera', 'Panera Bread'], ['subway', 'Subway'], ['taco bell', 'Taco Bell'],
    ['wendy s', "Wendy's"], ['burger king', 'Burger King'], ['chick fil a', 'Chick-fil-A'], ['domino', "Domino's"], ['pizza hut', 'Pizza Hut'],
    ['little caesars', 'Little Caesars'], ['jet s pizza', "Jet's Pizza"], ['buddy s', "Buddy's Pizza"], ['olive garden', 'Olive Garden'],
    ['applebee', "Applebee's"], ['chili s', "Chili's"], ['culver', "Culver's"], ['five guys', 'Five Guys'], ['panda express', 'Panda Express'],
    ['qdoba', 'Qdoba'], ['noodles', 'Noodles & Company'], ['red robin', 'Red Robin'], ['texas roadhouse', 'Texas Roadhouse'], ['ihop', 'IHOP'],
    ['denny s', "Denny's"], ['coney island', 'Coney Island'], ['doordash', 'DoorDash'], ['grubhub', 'Grubhub'], ['uber eats', 'Uber Eats'],
  ]),
  ...A('cat-transport', [
    ['uber', 'Uber'], ['lyft', 'Lyft'], ['parkmobile', 'ParkMobile'], ['spothero', 'SpotHero'], ['amtrak', 'Amtrak'], ['smart bus', 'SMART'],
    ['ddot', 'DDOT'], ['e zpass', 'E-ZPass'], ['mackinac bridge', 'Mackinac Bridge'],
  ]),
  ...A('cat-vehicle', [
    ['jiffy lube', 'Jiffy Lube'], ['valvoline', 'Valvoline'], ['autozone', 'AutoZone'], ['advance auto', 'Advance Auto Parts'],
    ['o reilly', "O'Reilly Auto Parts"], ['discount tire', 'Discount Tire'], ['firestone', 'Firestone'], ['belle tire', 'Belle Tire'],
    ['midas', 'Midas'], ['meineke', 'Meineke'], ['car wash', 'Car wash'], ['secretary of state', 'Secretary of State'],
  ]),
  ...A('cat-household', [
    ['home depot', 'The Home Depot'], ['lowe s', "Lowe's"], ['menards', 'Menards'], ['ace hardware', 'Ace Hardware'], ['ikea', 'IKEA'],
    ['bed bath', 'Bed Bath & Beyond'], ['dollar tree', 'Dollar Tree'], ['dollar general', 'Dollar General'], ['family dollar', 'Family Dollar'],
  ]),
  ...A('cat-utilities', [
    ['dte', 'DTE Energy'], ['consumers energy', 'Consumers Energy'], ['great lakes water', 'Great Lakes Water Authority'], ['water department', 'Water'],
    ['waste management', 'Waste Management'], ['republic services', 'Republic Services'],
  ]),
  ...A('cat-internet', [
    ['comcast', 'Comcast'], ['xfinity', 'Xfinity'], ['at t', 'AT&T'], ['verizon', 'Verizon'], ['t mobile', 'T-Mobile'], ['wow internet', 'WOW!'],
    ['spectrum', 'Spectrum'], ['mint mobile', 'Mint Mobile'], ['google fi', 'Google Fi'], ['visible', 'Visible'],
  ]),
  ...A('cat-shopping', [
    ['amazon', 'Amazon'], ['best buy', 'Best Buy'], ['kohl s', "Kohl's"], ['macy s', "Macy's"], ['tj maxx', 'TJ Maxx'], ['marshalls', 'Marshalls'],
    ['old navy', 'Old Navy'], ['gap', 'Gap'], ['nordstrom', 'Nordstrom'], ['ross', 'Ross'], ['burlington', 'Burlington'], ['h m', 'H&M'],
    ['uniqlo', 'Uniqlo'], ['nike', 'Nike'], ['apple store', 'Apple Store'], ['etsy', 'Etsy'], ['ebay', 'eBay'], ['michaels', 'Michaels'],
  ]),
  ...A('cat-health', [
    ['cvs', 'CVS'], ['walgreens', 'Walgreens'], ['rite aid', 'Rite Aid'], ['pharmacy', 'Pharmacy'], ['urgent care', 'Urgent care'],
  ]),
  ...A('cat-entertainment', [
    ['amc', 'AMC Theatres'], ['regal', 'Regal'], ['emagine', 'Emagine'], ['ticketmaster', 'Ticketmaster'], ['steam', 'Steam'],
    ['playstation', 'PlayStation'], ['xbox', 'Xbox'], ['nintendo', 'Nintendo'], ['topgolf', 'Topgolf'],
  ]),
  ...A('cat-subscriptions', [
    ['netflix', 'Netflix'], ['spotify', 'Spotify'], ['hulu', 'Hulu'], ['disney plus', 'Disney+'], ['disney', 'Disney+'], ['hbo', 'Max'],
    ['youtube premium', 'YouTube Premium'], ['apple com bill', 'Apple'], ['icloud', 'iCloud'], ['google one', 'Google One'], ['peacock', 'Peacock'],
    ['paramount', 'Paramount+'], ['audible', 'Audible'], ['prime video', 'Prime Video'], ['amazon prime', 'Amazon Prime'], ['microsoft 365', 'Microsoft 365'],
  ]),
  ...A('cat-travel', [
    ['delta air', 'Delta'], ['united airlines', 'United'], ['american airlines', 'American Airlines'], ['southwest', 'Southwest'],
    ['spirit airlines', 'Spirit'], ['marriott', 'Marriott'], ['hilton', 'Hilton'], ['hyatt', 'Hyatt'], ['airbnb', 'Airbnb'], ['expedia', 'Expedia'],
    ['booking com', 'Booking.com'], ['enterprise rent', 'Enterprise'], ['hertz', 'Hertz'],
  ]),
  ...A('cat-personal', [['great clips', 'Great Clips'], ['supercuts', 'Supercuts'], ['ulta', 'Ulta Beauty'], ['sephora', 'Sephora'], ['sport clips', 'Sport Clips']]),
  ...A('cat-pets', [['petsmart', 'PetSmart'], ['petco', 'Petco'], ['chewy', 'Chewy'], ['banfield', 'Banfield']]),
  ...A('cat-education', [['coursera', 'Coursera'], ['udemy', 'Udemy'], ['barnes noble', 'Barnes & Noble'], ['scholastic', 'Scholastic']]),
  ...A('cat-insurance', [
    ['state farm', 'State Farm'], ['geico', 'GEICO'], ['progressive', 'Progressive'], ['allstate', 'Allstate'], ['auto owners', 'Auto-Owners'],
    ['liberty mutual', 'Liberty Mutual'], ['farmers insurance', 'Farmers'], ['usaa', 'USAA'],
  ]),
  ...A('cat-gifts', [['gofundme', 'GoFundMe'], ['red cross', 'Red Cross'], ['salvation army', 'Salvation Army'], ['goodwill', 'Goodwill']]),
];

const KEYWORDS: ReadonlyArray<[RegExp, string, string]> = [
  [/\b(gas|fuel|petro|petroleum|gas station)\b/, 'cat-fuel', 'name mentions fuel'],
  [/\b(pharmacy|drug|clinic|medical|dental|dentist|optical|vision|hospital|health)\b/, 'cat-health', 'name mentions health/pharmacy'],
  [/\b(cafe|coffee|espresso|bakery|donut|doughnut|tea house|boba|ice cream|creamery)\b/, 'cat-coffee', 'name mentions coffee or snacks'],
  [/\b(restaurant|grill|pizza|pizzeria|burger|taco|taqueria|sushi|diner|bistro|kitchen|bbq|barbecue|steakhouse|tavern|pub|brewery|cantina|ramen|pho|curry|biryani|deli|wings|eatery)\b/, 'cat-restaurants', 'name mentions a restaurant'],
  [/\b(market|grocery|grocer|supermarket|foods|food store|produce|halal|farmers market)\b/, 'cat-groceries', 'name mentions groceries'],
  [/\b(parking|garage|transit|taxi|cab|toll|airport shuttle)\b/, 'cat-transport', 'name mentions parking or transit'],
  [/\b(auto|tire|tires|oil change|collision|car wash|automotive|muffler|brake)\b/, 'cat-vehicle', 'name mentions vehicle service'],
  [/\b(hardware|home improvement|lumber|garden center|cleaners|laundromat|laundry)\b/, 'cat-household', 'name mentions household goods'],
  [/\b(electric|energy|water|sewer|utility|utilities|trash|waste)\b/, 'cat-utilities', 'name mentions a utility'],
  [/\b(wireless|mobile|internet|broadband|cable|telecom)\b/, 'cat-internet', 'name mentions phone or internet'],
  [/\b(salon|barber|spa|nail|beauty|cosmetics)\b/, 'cat-personal', 'name mentions personal care'],
  [/\b(pet|vet|veterinary|animal hospital|grooming)\b/, 'cat-pets', 'name mentions pets'],
  [/\b(school|university|college|tuition|academy|bookstore|books)\b/, 'cat-education', 'name mentions education'],
  [/\b(insurance|assurance)\b/, 'cat-insurance', 'name mentions insurance'],
  [/\b(hotel|motel|inn|resort|airline|airlines|airways|rental car)\b/, 'cat-travel', 'name mentions travel'],
  [/\b(cinema|theater|theatre|movies|museum|zoo|concert|bowling|arcade)\b/, 'cat-entertainment', 'name mentions entertainment'],
  [/\b(subscription|membership)\b/, 'cat-subscriptions', 'name mentions a subscription'],
  [/\b(rent|apartments|property management|hoa|mortgage)\b/, 'cat-housing', 'name mentions housing'],
  [/\b(church|temple|mosque|charity|foundation|donation)\b/, 'cat-gifts', 'name mentions donations'],
  [/\b(florist|flowers|gift)\b/, 'cat-gifts', 'name mentions gifts'],
];

const FUEL_LINE = /\b(gal|gals|gallons?|unleaded|unld|regular|reg|premium|prem|diesel|plus|pump\s*#?\s*\d+|price\s*\/\s*gal|fuel)\b/i;
const RX_LINE = /\b(rx|prescription|copay)\b/i;

function containsWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  const h = ` ${hay} `;
  return h.includes(` ${needle} `) || (needle.length >= 5 && h.includes(` ${needle}`));
}

export function findAlias(merchantNormalized: string): Alias | undefined {
  // Longest pattern first so "costco gas" beats "costco".
  let best: Alias | undefined;
  for (const a of MERCHANT_ALIASES) {
    if (containsWord(merchantNormalized, a.pattern) && (!best || a.pattern.length > best.pattern.length)) best = a;
  }
  return best;
}

export function classify(input: {
  merchantName: string;
  lineItems?: readonly string[];
  rules?: readonly MerchantRule[];
  validCategoryIds?: ReadonlySet<string>;
}): Classification {
  const norm = normalizeMerchant(input.merchantName);
  const valid = (id: string) => !input.validCategoryIds || input.validCategoryIds.has(id);

  // 1. Household rules
  const rules = (input.rules ?? [])
    .filter((r) => !r.deletedAt && r.merchantPattern && containsWord(norm, r.merchantPattern) && valid(r.categoryId))
    .sort((a, b) => b.merchantPattern.length - a.merchantPattern.length || b.priority - a.priority);
  if (rules[0]) return { categoryId: rules[0].categoryId, confidence: 'high', reason: `Your household rule for "${rules[0].merchantPattern}"` };

  const lines = input.lineItems ?? [];
  const hasFuelLine = lines.some((l) => FUEL_LINE.test(l));

  // 2. Known merchants
  const alias = findAlias(norm);
  if (alias && valid(alias.categoryId)) {
    if (alias.fuel && lines.length > 0 && !hasFuelLine && valid('cat-coffee')) {
      return { categoryId: 'cat-coffee', confidence: 'medium', reason: `${alias.name} is a fuel station, but the receipt shows no fuel — likely snacks`, canonicalName: alias.name };
    }
    return { categoryId: alias.categoryId, confidence: 'high', reason: `${alias.name} is a known merchant`, canonicalName: alias.name };
  }

  // 3. Line items
  if (hasFuelLine && valid('cat-fuel')) return { categoryId: 'cat-fuel', confidence: 'medium', reason: 'Receipt lines mention fuel' };
  if (lines.some((l) => RX_LINE.test(l)) && valid('cat-health')) return { categoryId: 'cat-health', confidence: 'medium', reason: 'Receipt lines mention a prescription' };

  // 4. Keywords
  for (const [re, cat, why] of KEYWORDS) {
    if (re.test(norm) && valid(cat)) return { categoryId: cat, confidence: 'low', reason: `The ${why}` };
  }
  return { categoryId: UNCATEGORIZED_ID, confidence: 'low', reason: 'No rule matched' };
}

/** After this many corrections to the same category, offer to create a household rule. */
export const CORRECTIONS_BEFORE_OFFER = 2;

export function recordCorrection(
  stats: Record<string, Record<string, number>>,
  merchantNormalized: string,
  chosenCategoryId: string,
): { stats: Record<string, Record<string, number>>; offer: boolean } {
  const key = merchantNormalized.split(' ').slice(0, 3).join(' ');
  const next = { ...stats, [key]: { ...(stats[key] ?? {}) } };
  next[key]![chosenCategoryId] = (next[key]![chosenCategoryId] ?? 0) + 1;
  return { stats: next, offer: next[key]![chosenCategoryId]! >= CORRECTIONS_BEFORE_OFFER };
}

export function rulePatternFor(merchantNormalized: string): string {
  const alias = findAlias(merchantNormalized);
  return alias ? alias.pattern : merchantNormalized.split(' ').slice(0, 3).join(' ');
}
