// Turns "something spicy and cheap" into terms we can look for in a
// restaurant's cuisine tags, its name, and what people said about it.

export const MOODS = [
  'Comfort food', 'Spicy', 'Noodles', 'Tacos', 'BBQ', 'Date night',
  'Cheap eats', 'Brunch', 'Healthy', 'Late night', 'Something sweet',
  'Coffee', 'Drinks', 'Hidden gem',
];

// What a word means on a menu. Keys are normalized (lowercase, singular).
const MEANS = {
  comfort: ['ramen', 'pho', 'barbecue', 'pizza', 'burger', 'diner', 'soul food', 'fried chicken', 'noodle', 'dumpling', 'southern', 'mac and cheese', 'chicken fried steak'],
  'comfort food': ['ramen', 'pho', 'barbecue', 'pizza', 'burger', 'diner', 'soul food', 'fried chicken', 'noodle', 'dumpling', 'southern'],
  cozy: ['ramen', 'italian', 'wine', 'bakery', 'cafe', 'cozy', 'pho'],
  spicy: ['thai', 'sichuan', 'szechuan', 'indian', 'korean', 'hot chicken', 'curry', 'hunan', 'spicy', 'mexican', 'nashville'],
  noodle: ['ramen', 'pho', 'udon', 'noodle', 'soba', 'thai', 'vietnamese', 'chinese', 'pasta', 'lo mein'],
  soup: ['pho', 'ramen', 'soup', 'noodle', 'vietnamese', 'menudo'],
  cheap: ['taco', 'food truck', 'pho', 'banh mi', 'sandwich', 'burrito', 'cheap', 'street food', 'taqueria', 'fast food'],
  'cheap eat': ['taco', 'food truck', 'pho', 'banh mi', 'sandwich', 'burrito', 'cheap', 'street food', 'taqueria'],
  'date night': ['italian', 'french', 'wine', 'tapas', 'small plates', 'cocktail', 'omakase', 'romantic', 'date night', 'steak'],
  date: ['italian', 'french', 'wine', 'tapas', 'cocktail', 'omakase', 'romantic', 'date night'],
  fancy: ['french', 'omakase', 'tasting menu', 'steak', 'fine dining', 'wine'],
  brunch: ['brunch', 'breakfast', 'pancake', 'biscuit', 'migas', 'eggs', 'bakery', 'cafe'],
  breakfast: ['breakfast', 'brunch', 'taco', 'biscuit', 'bakery', 'cafe', 'migas', 'diner'],
  healthy: ['salad', 'poke', 'vegan', 'vegetarian', 'mediterranean', 'bowl', 'juice', 'greek', 'healthy'],
  'late night': ['late night', 'pizza', 'taco', 'diner', 'burger', 'bar', 'open late'],
  late: ['late night', 'pizza', 'taco', 'diner', 'burger', 'open late'],
  sweet: ['dessert', 'ice cream', 'bakery', 'donut', 'pastry', 'cake', 'gelato', 'pie', 'cookie', 'chocolate'],
  'something sweet': ['dessert', 'ice cream', 'bakery', 'donut', 'pastry', 'cake', 'gelato', 'pie', 'cookie'],
  dessert: ['dessert', 'ice cream', 'bakery', 'pastry', 'cake', 'gelato', 'pie'],
  coffee: ['coffee', 'cafe', 'espresso', 'latte', 'coffee shop'],
  drink: ['cocktail', 'bar', 'pub', 'wine', 'beer', 'brewery', 'biergarten'],
  cocktail: ['cocktail', 'bar', 'speakeasy'],
  beer: ['beer', 'brewery', 'pub', 'biergarten'],
  wine: ['wine', 'wine bar'],
  'hidden gem': ['hidden gem', 'underrated', 'gem', 'slept on', 'sleeper'],
  bbq: ['barbecue', 'bbq', 'brisket', 'smoked', 'ribs'],
  barbecue: ['barbecue', 'bbq', 'brisket', 'smoked', 'ribs'],
  taco: ['taco', 'mexican', 'tex mex', 'taqueria', 'birria', 'al pastor'],
  burger: ['burger', 'smash burger', 'cheeseburger'],
  pizza: ['pizza', 'pizzeria', 'slice', 'neapolitan'],
  sushi: ['sushi', 'japanese', 'omakase', 'nigiri'],
  seafood: ['seafood', 'fish', 'oyster', 'crab', 'shrimp', 'cajun', 'crawfish', 'lobster'],
  vegan: ['vegan', 'plant based', 'vegetarian'],
  vegetarian: ['vegetarian', 'vegan', 'plant based', 'indian', 'mediterranean', 'falafel'],
  chinese: ['chinese', 'dumpling', 'dim sum', 'sichuan', 'cantonese', 'hunan', 'noodle'],
  dumpling: ['dumpling', 'dim sum', 'xiao long bao', 'chinese', 'gyoza', 'momo'],
  sandwich: ['sandwich', 'deli', 'banh mi', 'sub', 'hoagie'],
  chicken: ['chicken', 'fried chicken', 'hot chicken', 'wings', 'rotisserie'],
  hangover: ['taco', 'pho', 'breakfast', 'burger', 'diner', 'menudo', 'ramen'],
  hungover: ['taco', 'pho', 'breakfast', 'burger', 'diner', 'menudo', 'ramen'],
  mexican: ['mexican', 'taco', 'tex mex', 'taqueria'],
  japanese: ['japanese', 'sushi', 'ramen', 'izakaya', 'udon'],
  indian: ['indian', 'curry', 'tandoori', 'biryani', 'dosa'],
  steak: ['steak', 'steakhouse', 'steak house'],
  bakery: ['bakery', 'pastry', 'bread', 'croissant'],
  quick: ['food truck', 'sandwich', 'taco', 'counter', 'fast food'],
};

// OSM uses its own cuisine words; map ours onto them.
const OSM_ALIASES = {
  bbq: 'barbecue', 'tex mex': 'tex-mex', 'coffee shop': 'coffee_shop',
  'ice cream': 'ice_cream', 'fast food': 'fast_food', dumpling: 'dumplings',
};

const FILLER = new Set(`i im want wanna need some something somewhere spot place
places food the a an and or for with of to in on near me my good great best
really very kinda kind sort like mood craving crave feeling feel eat eating get
grab let lets go going tonight today now real some any that this place around
local who what where open please`.split(/\s+/));

export function normalize(text) {
  return text
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function singular(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && word.endsWith('es') && /(ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Returns groups: one per idea the person typed. Each group lists the
// terms that would satisfy it, the typed word itself weighted highest.
export function parseCraving(text) {
  const words = normalize(text).split(' ').filter(Boolean).map(singular);
  const groups = [];
  let i = 0;
  while (i < words.length) {
    // Prefer two-word ideas ("date night", "hidden gem") over single words.
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : null;
    if (pair && MEANS[pair]) {
      groups.push(group(pair));
      i += 2;
      continue;
    }
    if (!FILLER.has(words[i]) && words[i].length > 1) groups.push(group(words[i]));
    i += 1;
  }
  return groups;
}

function group(word) {
  const terms = new Map([[word, 1]]);
  for (const t of MEANS[word] || []) if (!terms.has(t)) terms.set(t, 0.7);
  for (const [t, w] of [...terms]) {
    if (OSM_ALIASES[t] && !terms.has(OSM_ALIASES[t])) terms.set(OSM_ALIASES[t], w);
  }
  return { word, terms };
}
