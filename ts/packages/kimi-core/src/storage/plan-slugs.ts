/**
 * Plan-file slug generator — Phase 18 §D.1.
 *
 * Ports Python `kimi_cli/tools/plan/heroes.py`: each session gets a
 * human-readable slug composed of three Marvel/DC hero names joined by
 * `-`. The slug is cached per `sessionId` so repeated lookups are
 * idempotent. When the randomly-assembled slug collides with the
 * caller-supplied `existingSlugs` set 20 times in a row, we append the
 * first 8 chars of `sessionId` as a tiebreaker (matches the Python
 * fallback path `{slug}-{session_id[:8]}`).
 *
 * Note: uses `crypto.randomInt` for uniform secure randomness, matching
 * Python `secrets.choice`.
 */

import { randomInt } from 'node:crypto';

export const HERO_NAMES: readonly string[] = [
  // --- Marvel ---
  'iron-man',
  'spider-man',
  'captain-america',
  'thor',
  'hulk',
  'black-widow',
  'hawkeye',
  'black-panther',
  'doctor-strange',
  'scarlet-witch',
  'vision',
  'falcon',
  'war-machine',
  'ant-man',
  'wasp',
  'captain-marvel',
  'gamora',
  'star-lord',
  'groot',
  'rocket',
  'drax',
  'mantis',
  'nebula',
  'shang-chi',
  'moon-knight',
  'ms-marvel',
  'she-hulk',
  'echo',
  'wolverine',
  'cyclops',
  'storm',
  'jean-grey',
  'rogue',
  'beast',
  'nightcrawler',
  'colossus',
  'shadowcat',
  'jubilee',
  'cable',
  'deadpool',
  'bishop',
  'magik',
  'iceman',
  'archangel',
  'psylocke',
  'dazzler',
  'forge',
  'havok',
  'polaris',
  'emma-frost',
  'namor',
  'silver-surfer',
  'adam-warlock',
  'nova',
  'quasar',
  'sentry',
  'blue-marvel',
  'spectrum',
  'squirrel-girl',
  'cloak',
  'dagger',
  'punisher',
  'elektra',
  'luke-cage',
  'iron-fist',
  'jessica-jones',
  'daredevil',
  'blade',
  'ghost-rider',
  'morbius',
  'venom',
  'carnage',
  'silk',
  'spider-gwen',
  'miles-morales',
  'america-chavez',
  'kate-bishop',
  'yelena-belova',
  'white-tiger',
  'moon-girl',
  'devil-dinosaur',
  'amadeus-cho',
  'riri-williams',
  'kamala-khan',
  'sam-alexander',
  'nova-prime',
  'medusa',
  'black-bolt',
  'crystal',
  'karnak',
  'gorgon',
  'lockjaw',
  'quake',
  'mockingbird',
  'bobbi-morse',
  'maria-hill',
  'nick-fury',
  'phil-coulson',
  'winter-soldier',
  'us-agent',
  'patriot',
  'speed',
  'wiccan',
  'hulkling',
  'stature',
  'yellowjacket',
  'tigra',
  'hellcat',
  'valkyrie',
  'sif',
  'beta-ray-bill',
  'hercules',
  'wonder-man',
  'taskmaster',
  'domino',
  'cannonball',
  'sunspot',
  'wolfsbane',
  'warpath',
  'multiple-man',
  'banshee',
  'siryn',
  'monet',
  'rictor',
  'shatterstar',
  'longshot',
  'daken',
  'x-23',
  'fantomex',
  // --- DC ---
  'batman',
  'superman',
  'wonder-woman',
  'flash',
  'aquaman',
  'green-lantern',
  'martian-manhunter',
  'cyborg',
  'hawkgirl',
  'green-arrow',
  'black-canary',
  'zatanna',
  'constantine',
  'shazam',
  'blue-beetle',
  'booster-gold',
  'firestorm',
  'atom',
  'hawkman',
  'plastic-man',
  'red-tornado',
  'starfire',
  'raven',
  'beast-boy',
  'robin',
  'nightwing',
  'batgirl',
  'batwoman',
  'red-hood',
  'signal',
  'orphan',
  'spoiler',
  'catwoman',
  'huntress',
  'supergirl',
  'superboy',
  'power-girl',
  'steel',
  'stargirl',
  'wildcat',
  'doctor-fate',
  'mister-terrific',
  'hourman',
  'sandman',
  'spectre',
  'phantom-stranger',
  'swamp-thing',
  'animal-man',
  'deadman',
  'vixen',
  'black-lightning',
  'static',
  'icon',
  'rocket-dc',
  'captain-atom',
  'fire',
  'ice',
  'elongated-man',
  'metamorpho',
  'black-hawk',
  'crimson-avenger',
  'doctor-mid-nite',
  'jakeem-thunder',
  'mister-miracle',
  'big-barda',
  'orion',
  'lightray',
  'forager',
  'killer-frost',
  'jessica-cruz',
  'simon-baz',
  'john-stewart',
  'guy-gardner',
  'kyle-rayner',
  'hal-jordan',
  'wally-west',
  'barry-allen',
  'jay-garrick',
  'impulse',
  'kid-flash',
  'donna-troy',
  'tempest',
  'aqualad',
  'miss-martian',
  'terra',
  'jericho',
  'ravager',
  'red-star',
  'pantha',
  'argent',
  'damage',
  'jade',
  'obsidian',
  'cyclone',
  'atom-smasher',
  'maxima',
  'starman',
  'liberty-belle',
  'dove',
  'hawk',
  'blue-devil',
  'creeper',
  'ragman',
  'thunder',
];

const MAX_ATTEMPTS = 20;

const slugCache = new Map<string, string>();

function pickHero(): string {
  return HERO_NAMES[randomInt(HERO_NAMES.length)] ?? HERO_NAMES[0] ?? 'kimi';
}

function assembleSlug(): string {
  return `${pickHero()}-${pickHero()}-${pickHero()}`;
}

/**
 * TODO(Slice 18-3): callers must scan `<KIMI_HOME>/plans/` for
 * previously-assigned slugs and pass them as `existingSlugs`. The
 * current call sites pass a literal empty `Set()` as a placeholder,
 * which means collision avoidance is only effective within a single
 * process (via `slugCache`) — two sessions that start after a process
 * restart can still collide. The plans directory scan is Slice 18-3
 * scope because it depends on PlanFileManager wiring in the host.
 */
export function generatePlanSlug(sessionId: string, existingSlugs: Set<string>): string {
  const cached = slugCache.get(sessionId);
  if (cached !== undefined) return cached;

  let slug = '';
  let collided = true;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    slug = assembleSlug();
    if (!existingSlugs.has(slug)) {
      collided = false;
      break;
    }
  }
  if (collided) {
    slug = `${slug}-${sessionId.slice(0, 8)}`;
  }
  slugCache.set(sessionId, slug);
  return slug;
}

/** Test-only: clear the per-process slug cache so each describe block starts clean. */
export function __resetPlanSlugCache(): void {
  slugCache.clear();
}
