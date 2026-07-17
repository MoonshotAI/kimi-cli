/**
 * Plan file slug generation using Marvel and DC hero names.
 * Corresponds to Python tools/plan/heroes.py
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

export const PLANS_DIR = join(homedir(), ".kimi", "plans");

export const HERO_NAMES: string[] = [
	// --- Marvel ---
	"iron-man",
	"spider-man",
	"captain-america",
	"thor",
	"hulk",
	"black-widow",
	"hawkeye",
	"black-panther",
	"doctor-strange",
	"scarlet-witch",
	"vision",
	"falcon",
	"war-machine",
	"ant-man",
	"wasp",
	"captain-marvel",
	"gamora",
	"star-lord",
	"groot",
	"rocket",
	"drax",
	"mantis",
	"nebula",
	"shang-chi",
	"moon-knight",
	"ms-marvel",
	"she-hulk",
	"echo",
	"wolverine",
	"cyclops",
	"storm",
	"jean-grey",
	"rogue",
	"beast",
	"nightcrawler",
	"colossus",
	"shadowcat",
	"jubilee",
	"cable",
	"deadpool",
	"bishop",
	"magik",
	"iceman",
	"archangel",
	"psylocke",
	"dazzler",
	"forge",
	"havok",
	"polaris",
	"emma-frost",
	"namor",
	"silver-surfer",
	"adam-warlock",
	"nova",
	"quasar",
	"sentry",
	"blue-marvel",
	"spectrum",
	"squirrel-girl",
	"cloak",
	"dagger",
	"punisher",
	"elektra",
	"luke-cage",
	"iron-fist",
	"jessica-jones",
	"daredevil",
	"blade",
	"ghost-rider",
	"morbius",
	"venom",
	"carnage",
	"silk",
	"spider-gwen",
	"miles-morales",
	"america-chavez",
	"kate-bishop",
	"yelena-belova",
	"white-tiger",
	"moon-girl",
	"devil-dinosaur",
	"amadeus-cho",
	"riri-williams",
	"kamala-khan",
	"sam-alexander",
	"nova-prime",
	"medusa",
	"black-bolt",
	"crystal",
	"karnak",
	"gorgon",
	"lockjaw",
	"quake",
	"mockingbird",
	"bobbi-morse",
	"maria-hill",
	"nick-fury",
	"phil-coulson",
	"winter-soldier",
	"us-agent",
	"patriot",
	"speed",
	"wiccan",
	"hulkling",
	"stature",
	"yellowjacket",
	"tigra",
	"hellcat",
	"valkyrie",
	"sif",
	"beta-ray-bill",
	"hercules",
	"wonder-man",
	"taskmaster",
	"domino",
	"cannonball",
	"sunspot",
	"wolfsbane",
	"warpath",
	"multiple-man",
	"banshee",
	"siryn",
	"monet",
	"rictor",
	"shatterstar",
	"longshot",
	"daken",
	"x-23",
	"fantomex",
	// --- DC ---
	"batman",
	"superman",
	"wonder-woman",
	"flash",
	"aquaman",
	"green-lantern",
	"martian-manhunter",
	"cyborg",
	"hawkgirl",
	"green-arrow",
	"black-canary",
	"zatanna",
	"constantine",
	"shazam",
	"blue-beetle",
	"booster-gold",
	"firestorm",
	"atom",
	"hawkman",
	"plastic-man",
	"red-tornado",
	"starfire",
	"raven",
	"beast-boy",
	"robin",
	"nightwing",
	"batgirl",
	"batwoman",
	"red-hood",
	"signal",
	"orphan",
	"spoiler",
	"catwoman",
	"huntress",
	"supergirl",
	"superboy",
	"power-girl",
	"steel",
	"stargirl",
	"wildcat",
	"doctor-fate",
	"mister-terrific",
	"hourman",
	"sandman",
	"spectre",
	"phantom-stranger",
	"swamp-thing",
	"animal-man",
	"deadman",
	"vixen",
	"black-lightning",
	"static",
	"icon",
	"rocket-dc",
	"captain-atom",
	"fire",
	"ice",
	"elongated-man",
	"metamorpho",
	"black-hawk",
	"crimson-avenger",
	"doctor-mid-nite",
	"jakeem-thunder",
	"mister-miracle",
	"big-barda",
	"orion",
	"lightray",
	"forager",
	"killer-frost",
	"jessica-cruz",
	"simon-baz",
	"john-stewart",
	"guy-gardner",
	"kyle-rayner",
	"hal-jordan",
	"wally-west",
	"barry-allen",
	"jay-garrick",
	"impulse",
	"kid-flash",
	"donna-troy",
	"tempest",
	"aqualad",
	"miss-martian",
	"terra",
	"jericho",
	"ravager",
	"red-star",
	"pantha",
	"argent",
	"damage",
	"jade",
	"obsidian",
	"cyclone",
	"atom-smasher",
	"maxima",
	"starman",
	"liberty-belle",
];

const _slugCache = new Map<string, string>();

/** Pre-warm the in-process slug cache with a previously persisted slug. */
export function seedSlugCache(sessionId: string, slug: string): void {
	_slugCache.set(sessionId, slug);
}

/** Get or create a plan file slug for the given session. */
export function getOrCreateSlug(sessionId: string): string {
	const cached = _slugCache.get(sessionId);
	if (cached) return cached;

	mkdirSync(PLANS_DIR, { recursive: true });

	let slug = "";
	for (let i = 0; i < 20; i++) {
		const words: string[] = [];
		for (let j = 0; j < 3; j++) {
			words.push(HERO_NAMES[Math.floor(Math.random() * HERO_NAMES.length)]!);
		}
		slug = words.join("-");
		if (!existsSync(join(PLANS_DIR, `${slug}.md`))) {
			break;
		}
		// If last attempt and still colliding, append session prefix
		if (i === 19) {
			slug = `${slug}-${sessionId.slice(0, 8)}`;
		}
	}

	_slugCache.set(sessionId, slug);
	return slug;
}

/** Get the plan file path for the given session. */
export function getPlanFilePath(sessionId: string): string {
	return join(PLANS_DIR, `${getOrCreateSlug(sessionId)}.md`);
}

/** Read the plan file content for the given session, or null if not found. */
export function readPlanFile(sessionId: string): string | null {
	const path = getPlanFilePath(sessionId);
	try {
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
