/**
 * 4-Random-Word Tournament Join Key Generator & Normalizer.
 * Generates memorable, URL-safe, easy-to-type 4-word keys (e.g. `amber-paddle-swift-comet`)
 * that uniquely identify tournaments across local storage, LAN sync, and future online hosting.
 */

export const WORD_LIST = [
  'acorn', 'amber', 'anchor', 'apple', 'arcade', 'arrow', 'aspen', 'atlas',
  'aurora', 'badge', 'banjo', 'baron', 'basil', 'beacon', 'berry', 'bison',
  'blade', 'blaze', 'bliss', 'bloom', 'bolt', 'bonus', 'bounce', 'breeze',
  'brick', 'bridge', 'bright', 'bronze', 'brook', 'cabin', 'cactus', 'canyon',
  'cargo', 'cedar', 'champ', 'charm', 'chess', 'chime', 'cider', 'citrus',
  'cliff', 'cloud', 'clover', 'coach', 'coast', 'cobalt', 'comet', 'copper',
  'coral', 'cosmos', 'court', 'craft', 'crane', 'creek', 'crest', 'crisp',
  'crown', 'crystal', 'cupid', 'curve', 'cyber', 'daisy', 'dancer', 'daring',
  'delta', 'denim', 'desert', 'deuce', 'disco', 'dodge', 'dolphin', 'domino',
  'dragon', 'drift', 'drum', 'dusk', 'eagle', 'echo', 'eclipse', 'ember',
  'emerald', 'engine', 'epic', 'fable', 'falcon', 'feather', 'ferry', 'fiesta',
  'finch', 'fjord', 'flame', 'flash', 'flint', 'flora', 'focus', 'forest',
  'forge', 'fossil', 'fox', 'frost', 'fusion', 'galaxy', 'garden', 'garnet',
  'geyser', 'giant', 'ginger', 'glacier', 'gleam', 'glide', 'globe', 'glory',
  'golden', 'gopher', 'grand', 'granite', 'groove', 'grove', 'harbor', 'harvest',
  'hawk', 'hazel', 'helium', 'heron', 'hollow', 'honey', 'horizon', 'humble',
  'hustle', 'igloo', 'impact', 'indigo', 'island', 'ivory', 'jacket', 'jade',
  'jaguar', 'jasper', 'jazzy', 'jester', 'jigsaw', 'jolly', 'journey', 'jubilant',
  'jumbo', 'jungle', 'juniper', 'kayak', 'kettle', 'kinetic', 'kingdom', 'kite',
  'kiwi', 'knight', 'koala', 'lagoon', 'lantern', 'laser', 'laurel', 'legend',
  'lemon', 'leopard', 'liberty', 'lilac', 'linden', 'lively', 'llama', 'lobster',
  'locket', 'lotus', 'lucky', 'lunar', 'lyric', 'magnet', 'magpie', 'mango',
  'maple', 'marble', 'marina', 'marmot', 'marshal', 'meadow', 'medal', 'melody',
  'mercury', 'meteor', 'mighty', 'mimosa', 'minty', 'mirage', 'mitten', 'mocha',
  'modern', 'monarch', 'monkey', 'moon', 'mossy', 'muffin', 'mustang', 'mystic',
  'nebula', 'nectar', 'neon', 'nettle', 'nickel', 'nimble', 'noble', 'noodle',
  'nordic', 'nova', 'nutmeg', 'oasis', 'obsidian', 'ocean', 'octane', 'olive',
  'omega', 'onyx', 'opal', 'orbit', 'orchid', 'oriole', 'osprey', 'otter',
  'outlaw', 'owl', 'pacific', 'paddle', 'palace', 'panda', 'panther', 'papaya',
  'parade', 'parrot', 'pastel', 'patio', 'peach', 'peacock', 'peanut', 'pearl',
  'pebble', 'pelican', 'penguin', 'pepper', 'perch', 'phantom', 'phoenix', 'piano',
  'picnic', 'pilot', 'pine', 'ping', 'pioneer', 'pippin', 'pirate', 'pixel',
  'planet', 'plasma', 'plaza', 'plucky', 'plum', 'pluto', 'pocket', 'polar',
  'pollen', 'polo', 'poncho', 'pong', 'poplar', 'poppy', 'portal', 'possum',
  'prairie', 'prism', 'prowl', 'puffin', 'pulse', 'puma', 'pumpkin', 'puzzle',
  'quartz', 'quest', 'quail', 'quasar', 'quiver', 'quokka', 'rabbit', 'racer',
  'radar', 'radish', 'raffle', 'raider', 'rainbow', 'rally', 'ramen', 'ranger',
  'rapid', 'raptor', 'raven', 'redwood', 'reef', 'regal', 'relic', 'remix',
  'retro', 'rhythm', 'ribbon', 'ridge', 'ripple', 'river', 'robin', 'robot',
  'rocket', 'rodeo', 'roller', 'rooster', 'rose', 'rover', 'royal', 'ruby',
  'runner', 'russet', 'rustic', 'saber', 'safari', 'saffron', 'sage', 'sailor',
  'salmon', 'salsa', 'samba', 'sandal', 'sapphire', 'saturn', 'savanna', 'scarlet',
  'scepter', 'scooter', 'scout', 'scroll', 'seagull', 'sequoia', 'serene', 'serve',
  'shadow', 'shamrock', 'sherbet', 'shield', 'shimmer', 'sierra', 'signal', 'silver',
  'sizzle', 'skater', 'sketch', 'skipper', 'skyline', 'slate', 'sleigh', 'slice',
  'smash', 'smoky', 'snapper', 'snorkel', 'snowy', 'solar', 'sonic', 'sorbet',
  'spark', 'sparrow', 'spectra', 'sphinx', 'spice', 'spider', 'spin', 'spiral',
  'spirit', 'splash', 'sprint', 'spruce', 'sputnik', 'squash', 'squire', 'stadium',
  'stallion', 'star', 'stellar', 'sterling', 'stinger', 'stone', 'storm', 'stride',
  'striker', 'studio', 'summit', 'sunbeam', 'sundae', 'sunset', 'super', 'surf',
  'swift', 'sycamore', 'symphony', 'table', 'taco', 'taiga', 'talon', 'tandem',
  'tango', 'target', 'tartan', 'tavern', 'teapot', 'tempo', 'terra', 'thistle',
  'thunder', 'thyme', 'ticket', 'tidal', 'tiger', 'timber', 'tinsel', 'titan',
  'toaster', 'toffee', 'topaz', 'topspin', 'torch', 'tornado', 'toucan', 'tower',
  'tracker', 'trail', 'treasure', 'treble', 'trident', 'trilogy', 'trophy', 'tropic',
  'trout', 'truffle', 'trumpet', 'tulip', 'tumble', 'tundra', 'turbo', 'turret',
  'turtle', 'tuxedo', 'twilight', 'twister', 'tycoon', 'typhoon', 'ultra', 'umbra',
  'unicorn', 'unison', 'upland', 'uranus', 'urchin', 'utopia', 'valiant', 'valley',
  'valor', 'vanilla', 'vanguard', 'vapor', 'varsity', 'vault', 'vector', 'velvet',
  'venture', 'verbena', 'verdict', 'verge', 'verona', 'vertex', 'vesper', 'vibrant',
  'victor', 'viking', 'village', 'vintage', 'violet', 'violin', 'viper', 'vista',
  'vivid', 'vixen', 'volcano', 'volley', 'voltage', 'vortex', 'voyage', 'waffle',
  'wagon', 'walnut', 'walrus', 'wander', 'warden', 'warrior', 'wasabi', 'watch',
  'water', 'wave', 'weasel', 'weather', 'wharf', 'whisper', 'whistle', 'widget',
  'wildcat', 'willow', 'windy', 'winner', 'winter', 'wisdom', 'wizard', 'wombat',
  'wonder', 'woodland', 'wrangler', 'wren', 'yarrow', 'yellow', 'yeti', 'yodel',
  'yogurt', 'yonder', 'yucca', 'yule', 'zany', 'zeal', 'zebra', 'zenith',
  'zephyr', 'zero', 'zesty', 'zigzag', 'zinc', 'zinnia', 'zipper', 'zodiac',
];

const FOUR_WORD_PATTERN = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Normalizes any user-entered 4-word tournament key (spaces, hyphens, underscores, mixed case)
 * into canonical `word1-word2-word3-word4` format.
 */
export function normalizeFourWordId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isFourWordId(raw) {
  return FOUR_WORD_PATTERN.test(normalizeFourWordId(raw));
}

/**
 * Strips spaces, hyphens, underscores, and punctuation to produce a lowercase run-on
 * alphanumeric key (e.g. `Amber Paddle Swift Comet` or `amberpaddleswiftcomet` -> `amberpaddleswiftcomet`).
 */
export function compactJoinKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Computes Optimal String Alignment (Damerau-Levenshtein) edit distance between two strings.
 * Treats single-character insertion, deletion, substitution, OR adjacent letter swap (e.g. `padlde`)
 * as 1 typo.
 */
export function computeKeyEditDistance(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  const len1 = s1.length;
  const len2 = s2.length;
  if (s1 === s2) return 0;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  const dp = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
  for (let i = 0; i <= len1; i++) dp[i][0] = i;
  for (let j = 0; j <= len2; j++) dp[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      let best = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        s1[i - 1] === s2[j - 2] &&
        s1[i - 2] === s2[j - 1]
      ) {
        best = Math.min(best, dp[i - 2][j - 2] + 1); // adjacent transposition
      }
      dp[i][j] = best;
    }
  }
  return dp[len1][len2];
}

/**
 * Matches a user-entered join key against an expected tournament join key.
 * - Always allows run-on keys, spaces, dashes, underscores, and mixed case.
 * - Forgives up to `maxTypos` single-character edits or adjacent letter swaps.
 */
export function matchTournamentJoinKey(providedRaw, expectedRaw, { maxTypos = 0 } = {}) {
  const provided = compactJoinKey(providedRaw);
  const expected = compactJoinKey(expectedRaw);
  if (!provided || !expected) {
    return { matched: false, distance: Infinity };
  }
  if (provided === expected) {
    return { matched: true, distance: 0 };
  }
  const allowed = Math.max(0, Math.min(8, Math.floor(Number(maxTypos) || 0)));
  if (allowed === 0) {
    return { matched: false, distance: Infinity };
  }
  if (provided.length < 4 || Math.abs(provided.length - expected.length) > allowed) {
    return { matched: false, distance: Infinity };
  }
  const distance = computeKeyEditDistance(provided, expected);
  return { matched: distance <= allowed, distance };
}

function getRandomIndex(max, randomFn = null) {
  if (typeof randomFn === 'function') {
    return Math.floor(randomFn() * max) % max;
  }
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max) % max;
}

/**
 * Generates a unique 4-random-word tournament join key (4 distinct words joined by `-`).
 */
export function generateFourWordId(existingIds = null, randomFn = null) {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  for (let attempt = 0; attempt < 50; attempt++) {
    const chosen = [];
    const usedWordIdx = new Set();
    while (chosen.length < 4) {
      const idx = getRandomIndex(WORD_LIST.length, randomFn);
      if (usedWordIdx.has(idx)) continue;
      usedWordIdx.add(idx);
      chosen.push(WORD_LIST[idx]);
    }
    const candidate = chosen.join('-');
    if (!taken.has(candidate)) return candidate;
  }
  return `${WORD_LIST[0]}-${WORD_LIST[1]}-${WORD_LIST[2]}-${Date.now().toString(36)}`;
}

/**
 * Deterministically maps a legacy tournament ID (like `t-default` or `t-m1x9...`)
 * to a stable 4-word join key so both local storage and the sync server agree on the
 * exact same key for legacy tournaments without creating duplicates.
 */
export function deriveDeterministicFourWordId(seedStr) {
  const seed = String(seedStr || 't-default');
  if (isFourWordId(seed)) return normalizeFourWordId(seed);

  let h1 = 2166136261 >>> 0;
  let h2 = 3735928559 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i * 31), 2246822519) >>> 0;
  }

  const chosen = [];
  const used = new Set();
  let state = (h1 ^ (h2 << 1)) >>> 0;
  for (let w = 0; w < 4; w++) {
    let idx = 0;
    let guard = 0;
    do {
      state = (Math.imul(state ^ (w + 1 + guard), 1664525) + 1013904223) >>> 0;
      idx = state % WORD_LIST.length;
      guard += 1;
    } while (used.has(idx) && guard < 20);
    used.add(idx);
    chosen.push(WORD_LIST[idx]);
  }
  return chosen.join('-');
}

/**
 * Resolves the canonical 4-word join key for any tournament state object.
 */
export function resolveTournamentJoinCode(stateObj) {
  if (!stateObj || typeof stateObj !== 'object') {
    return generateFourWordId();
  }
  if (isFourWordId(stateObj.joinCode)) {
    return normalizeFourWordId(stateObj.joinCode);
  }
  if (isFourWordId(stateObj.tournamentId)) {
    return normalizeFourWordId(stateObj.tournamentId);
  }
  return deriveDeterministicFourWordId(stateObj.tournamentId || stateObj.tournamentName || 't-default');
}
