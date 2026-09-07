/**
 * chat/profanity — Apple Guideline 1.2 "method for filtering objectionable
 * content": masks profanity/slurs/sexual terms in chat text before broadcast.
 *
 * Pure module, no I/O. The word list + env-configured extras are compiled
 * into ONE RegExp at module load (not per-message), so masking a message is
 * a single `.replace()` pass regardless of list size.
 *
 * Leetspeak tolerance: within a matched word, characters can substitute for
 * common look-alikes (a<->@/4, i<->1/!, e<->3, o<->0, s<->$/5) and any
 * letter may repeat (e.g. "fuuuck", "sh!!it"). Matching is whole-word with
 * unicode-aware boundaries so substrings inside legitimate words ("class",
 * "assist", "Scunthorpe") are never touched.
 */

// ── Built-in word list (~150 common English profanities/slurs/sexual terms).
// Lowercase, no punctuation — each entry is a single "word" (letters only).
const BUILT_IN_WORDS: readonly string[] = [
  "2g1c", "acrotomophilia", "anal", "anilingus", "anus", "arse", "arsehole",
  "ass", "asses", "asshole", "assmunch", "autoerotic", "babeland", "bangbros",
  "bareback", "barelylegal", "barenaked", "bastard", "bastardo", "bbw",
  "bdsm", "beaner", "beastiality", "bestiality", "bimbo", "bitch", "bitchass",
  "bitches", "blowjob", "bollocks", "bondage", "boob", "boobs", "bootycall",
  "brownie", "bukkake", "bullshit", "bumblefuck", "bunghole", "busty",
  "cameltoe", "chink", "chinky", "cialis", "cipa", "clit", "clitoris",
  "cock", "cocks", "cocksucker", "coon", "coons", "coprophilia", "cornhole",
  "cracker", "crackwhore", "cum", "cumming", "cumshot", "cunilingus",
  "cunnilingus", "cunt", "cyberfuck", "dago", "damn", "deepthroat", "dick",
  "dickhead", "dildo", "dingleberry", "dipshit", "dogging", "doggystyle",
  "dommes", "douche", "douchebag", "dumbass", "dyke", "ecchi", "ejaculate",
  "ejaculation", "erotic", "escort", "extacy", "faggot", "fag", "fags",
  "fatass", "fecal", "felch", "fellatio", "feltch", "fetish", "figging",
  "fingering", "fisting", "fondle", "footjob", "fornicate", "fuck",
  "fucker", "fuckface", "fuckhead", "fucking", "fudgepacker", "futanari",
  "gangbang", "gay", "genitals", "goatse", "gokkun", "goldenshower",
  "gooch", "gook", "gooks", "gringo", "gspot", "handjob", "hentai", "hoe",
  "hoes", "homoerotic", "honky", "hooker", "horny", "incest", "injun",
  "jackoff", "jailbait", "jerkoff", "jizz", "kike", "kikes", "kinky",
  "kraut", "labia", "lesbian", "lezbian", "lolita", "masturbate",
  "masturbation", "milf", "molest", "moron", "motherfucker", "muff",
  "negro", "nigga", "niggas", "nigger", "niggers", "nipple", "nipples",
  "nude", "nudity", "nutsack", "orgasm", "orgy", "paki", "panty",
  "pedobear", "pedophile", "penetration", "penis", "phonesex", "pillowbiter",
  "pimp", "piss", "pissed", "playboy", "porn", "porno", "pornography",
  "prick", "prostitute", "pube", "pussy", "queaf", "queef", "queer",
  "raghead", "rape", "raping", "rapist", "rectal", "rectum", "redneck",
  "redskin", "rentafuck", "retard", "retarded", "rimjob", "sandnigger",
  "schlong", "scrotum", "semen", "sex", "sexo", "sexy", "shit", "shitass",
  "shitface", "shithead", "shitty", "skank", "slut", "slutty", "smut",
  "sodomize", "sodomy", "spic", "spick", "splooge", "squirting", "strapon",
  "tampon", "testicle", "threesome", "tits", "titties", "titty", "tranny",
  "twat", "vagina", "viagra", "vibrator", "vulva", "wank", "wanker",
  "wetback", "whore", "whores", "wop", "xxx", "zoophilia",
];

/**
 * Common leetspeak substitutions. Only characters with a plain-text
 * look-alike are mapped — every other letter matches itself literally.
 */
const LEET_MAP: Record<string, string> = {
  a: "a@4",
  b: "b8",
  c: "c",
  d: "d",
  e: "e3",
  f: "f",
  g: "g9",
  h: "h",
  i: "i1!",
  j: "j",
  k: "k",
  l: "l1",
  m: "m",
  n: "n",
  o: "o0",
  p: "p",
  q: "q",
  r: "r",
  s: "s$5",
  t: "t7",
  u: "u",
  v: "v",
  w: "w",
  x: "x",
  y: "y",
  z: "z2",
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a regex fragment for one plain-text word, tolerant of leetspeak + letter repeats. */
function buildWordPattern(word: string): string {
  return word
    .split("")
    .map((ch) => {
      const variants = LEET_MAP[ch];
      const charClass = variants ? `[${variants}]` : escapeRegExp(ch);
      // Allow the character (or its leet substitutes) to repeat 1+ times,
      // tolerating "fuuuck" / "sh!!it".
      return `${charClass}+`;
    })
    .join("");
}

/** Read extra blocked words from env at module load, merged with the built-in list. */
function loadExtraWordsFromEnv(): string[] {
  const raw = process.env.CHAT_BLOCKED_WORDS ?? "";
  return raw
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

function buildProfanityRegex(words: readonly string[]): RegExp | null {
  const unique = Array.from(new Set(words.filter((w) => w.length > 0)));
  if (unique.length === 0) return null;

  // Longest-first so overlapping entries (e.g. "ass" vs "asshole") prefer
  // the longer match.
  const sorted = [...unique].sort((a, b) => b.length - a.length);
  const alternation = sorted.map(buildWordPattern).join("|");

  // \b is not unicode-aware for the boundary itself, but our word list is
  // ASCII-letters-only, so pair it with unicode word-char lookarounds to
  // avoid matching inside e.g. "café-fuck" boundaries incorrectly and to
  // correctly treat non-ASCII letters (accented chars, CJK, etc.) adjacent
  // to a match as NOT a word boundary.
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "giu");
}

const ALL_WORDS: readonly string[] = [...BUILT_IN_WORDS, ...loadExtraWordsFromEnv()];

// Compiled once at module load — never rebuilt per-message.
const PROFANITY_REGEX = buildProfanityRegex(ALL_WORDS);

/**
 * Masks profanity in `text`, replacing each matched word with asterisks of
 * the same length. Non-matched content (including URLs and usernames, which
 * callers should never pass in here as part of `text`) is left untouched.
 */
export function maskProfanity(text: string): { text: string; masked: boolean } {
  if (!PROFANITY_REGEX || text.length === 0) {
    return { text, masked: false };
  }

  let masked = false;
  // Reset lastIndex defensively — the regex has the global flag and this
  // function may be called concurrently/re-entrantly.
  PROFANITY_REGEX.lastIndex = 0;

  const result = text.replace(PROFANITY_REGEX, (match) => {
    masked = true;
    return "*".repeat(match.length);
  });

  return { text: result, masked };
}
