import {fileIntent} from './file-intent';
export type NumericFilter = { field: string; op: "<" | ">" | "<=" | ">=" | "="; value: number };

export const MEDIA_FIELDS: Record<string, string> = {
  duration: "duration", length: "duration", channels: "channels", samplerate: "sampleRate",
  bitrate: "bitrate", width: "width", height: "height",
};

export function normalizeQuery(input: string): string {
  if(/[\x01\x02]/.test(input))throw new Error('Reserved control characters in query');
  const quoted: string[] = [];
  const clauses:string[]=[];
  let unquoted = input.replace(/"(?:\\.|[^"\\\n])*"/g, s => `\u0001${quoted.push(s) - 1}\u0001`);
  unquoted = unquoted.replace(/\(([^()]*)\)/g, (_, text) => `\u0002${clauses.push(translateIntent(text.replace(/\u0001(\d+)\u0001/g,(_,n)=>quoted[Number(n)])))-1}\u0002`);
  if (/[()]/.test(unquoted)) throw new Error("Use one level of balanced parentheses for natural language; quote literal parentheses");
  unquoted=unquoted.replace(/\u0002(\d+)\u0002/g,(_,n)=>clauses[Number(n)]);
  input = unquoted.replace(/\u0001(\d+)\u0001/g, (_, n) => quoted[Number(n)]);
  // Only translate the supported sentence form; other text remains a literal search.
  const sentence = input.match(/^(?:(?:suche|finde|zeig(?:e)?(?: mir)?)\s+)?(?:alle?\s+)?(?:meine?\s+)?(?:sounds?|audios?|samples?|klänge|sounddateien)(?:\s+die)?\s+(?:unter|kürzer als|kuerzer als|weniger als)\s*(\d+(?:[.,]\d+)?)\s*(ms|millisekunden?|s|sekunden?)(?:\s+(?:lang sind|gehen|sind))?[.!?]?$/i);
  if (sentence) return `type:audio duration:<${sentence[1].replace(",", ".")}${sentence[2].toLowerCase().startsWith("m") ? "ms" : "s"}`;
  return input.replace(/\b(audio|video|image|doc|code):(?=\s|$)/gi, "type:$1");
}

function translateIntent(text: string): string {
  if (!text.trim() || text.length > 512 || /[\x00-\x1f]/.test(text)) throw new Error("Natural-language clauses must contain 1–512 characters");
  const files=fileIntent(text);if(files!==undefined)return files;
  let value = text.toLowerCase().replace(/lasersounds?|laserklänge|laserklange/g, "laser sound");
  const filters: string[] = [];
  value = value.replace(/(?:unter|kürzer als|kuerzer als|weniger als|under|shorter than|über|ueber|länger als|laenger als|over|longer than)\s*(\d+(?:[.,]\d+)?)\s*(millisekunden?|ms|sekunden?|seconds?|secs?|s|minuten?|minutes?|mins?)/g, (s, n, unit) => {
    const op = /^(über|ueber|länger|laenger|over|longer)/.test(s) ? ">" : "<";
    filters.push(`duration:${op}${n.replace(",", ".")}${/^(ms|milli)/.test(unit) ? "ms" : /^(min)/.test(unit) ? "m" : "s"}`); return " ";
  });
  if (/\b(kurz\w*|short)\b/.test(value) && !filters.length) filters.push("duration:<1s");
  const words: Record<string, string> = {
    düster: "dark eerie", düstere: "dark eerie", düsteren: "dark eerie", duester: "dark eerie", duestere: "dark eerie",
    dunkel: "dark", dunkle: "dark", dunklen: "dark", unheimlich: "eerie", unheimliche: "eerie",
    hell: "bright", helle: "bright", hellen: "bright", lang: "long", lange: "long", langen: "long",
    metallisch: "metallic", metallische: "metallic", metallischen: "metallic", tief: "deep", tiefe: "deep", tiefen: "deep",
    hoch: "high pitched", hohe: "high pitched", hohen: "high pitched", weich: "soft", weiche: "soft", hart: "hard", harte: "hard",
    warm: "warm", warme: "warm", warmer: "warm", warmen: "warm", kalt: "cold", kalte: "cold", kalten: "cold",
    futuristisch: "futuristic", futuristische: "futuristic", futuristischer: "futuristic", futuristischen: "futuristic",
    elektronisch: "electronic", elektronische: "electronic", elektronischen: "electronic", aggressiv: "aggressive", aggressive: "aggressive",
    leise: "quiet", laut: "loud", laute: "loud", sanft: "gentle", sanfte: "gentle", verzerrt: "distorted", verzerrte: "distorted",
    schuss: "gunshot", schüsse: "gunshots", schussgeräusche: "gunshots", klick: "click", klicks: "clicks", piepsen: "beep", rauschen: "noise",
    explosion: "explosion", explosionen: "explosions", schritte: "footsteps", regen: "rain", wasser: "water", wind: "wind",
    hund: "dog", bellen: "barking", katze: "cat", vogel: "bird", vögel: "birds", klavier: "piano", trommel: "drum", drums: "drums",
    hundebellen: "dog barking", katzenmiauen: "cat meowing", vogelgezwitscher: "birds chirping", tastaturklicken: "keyboard typing",
    meeresrauschen: "ocean waves", windrauschen: "wind blowing", donnergrollen: "thunder rumbling", fußschritte: "footsteps", fusschritte: "footsteps",
    geräusch: "sound effect", geräusche: "sound effects", klang: "sound", klänge: "sounds", sounds: "sound effect", sound: "sound effect",
    stereo: "", mono: "", kurz: "", kurze: "", kurzen: "", suche: "", finde: "", zeige: "", mir: "", alle: "", meine: "", die: "", sind: "", gehen: "", bitte: "", und: "and", mit: "with", ohne: "without", ein: "", eine: "", einen: "",
  };
  if (/\bstereo\b/.test(value)) filters.push("channels:2");
  if (/\bmono\b/.test(value)) filters.push("channels:1");
  let description = value.replace(/[,;.!?]/g, " ").split(/\s+/).map(w => words[w] ?? w).join(" ").replace(/["\\\x01]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(sound effects?|sounds?|audios?|samples?)$/.test(description)) description = "";
  return ["type:audio", ...filters, ...(description ? [`sound:"${description}"`] : [])].join(" ");
}

export function soundPlan(description: string) {
  let anchor = description.replace(/\b(dark|eerie|bright|long|short|warm|cold|metallic|deep|high pitched|soft|hard|futuristic|electronic|aggressive|quiet|loud|gentle|distorted)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/\blaser\b/.test(anchor) && !/sword|saber|beam|continuous/.test(anchor)) anchor = "laser gun shot";
  if (!anchor || /^(sound effects?|sounds?)$/.test(anchor)) anchor = description;
  return { description, anchor, anchorWeight: anchor === description ? 0 : .8 };
}

export function numericFilters(key: string, value: string): NumericFilter[] {
  const field = MEDIA_FIELDS[key];
  const quantity = (s: string): number => {
    const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|secs?|seconds?|m|mins?|h|hours?|k|khz|hz|kbps|mbps)?$/i);
    if (!m) throw new Error(`Invalid ${key} filter: ${value}`);
    const unit = (m[2] || "").toLowerCase();
    const units = field === "duration" ? { "": 1, ms: .001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, h: 3600, hour: 3600, hours: 3600 }
      : field === "sampleRate" ? { "": 1, hz: 1, k: 1000, khz: 1000 }
      : field === "bitrate" ? { "": 1, k: 1000, kbps: 1000, mbps: 1_000_000 } : { "": 1 };
    if (!(unit in units)) throw new Error(`Invalid unit for ${key}: ${unit}`);
    const n = Number(m[1]) * units[unit];
    if (!Number.isFinite(n) || n > 1e12 || ((field === "channels" || field === "width" || field === "height") && (!Number.isInteger(n) || n < 1))) throw new Error(`Invalid ${key} filter: ${value}`);
    return n;
  };
  const range = value.split("..");
  if (range.length === 2) {
    const low = quantity(range[0]), high = quantity(range[1]);
    if (low > high) throw new Error(`Invalid ${key} range`);
    return [{ field, op: ">=", value: low }, { field, op: "<=", value: high }];
  }
  const m = value.match(/^(<=|>=|<|>|=)?(.+)$/);
  if (!m) throw new Error(`Invalid ${key} filter`);
  return [{ field, op: (m[1] || "=") as NumericFilter["op"], value: quantity(m[2]) }];
}

export const QUERY_HELP = {
  smartRanking:{examples:['report view:smart','ext:json view:smart','view:all','sort:relevance','learn:off'],commands:['fe learn status','fe learn disable','fe learn enable','fe learn reset'],notes:'App and Raycast default to view:smart: filename relevance, then documents/media ahead of code/config/data. System/generated/hidden/artifact paths are view-filtered, not deleted. Explicit extensions or filenames reveal artifacts. Successful opens train shared local query-scoped decaying preferences; typing alone does not. Explicit sort wins. No external model or query-time traversal.'},
  fileIntent:{examples:['(PDFs größer als 10 MB)','(Bilder in Downloads)','(Dateien aus den letzten 7 Tagen)','(favorisierte PDFs mindestens 1,5 MB)','(Dateien mit Namen "Q4 Bericht")'],notes:'Parentheses opt into bounded local rules for file groups, size, rolling day ranges, favorites, folders and sorting. No model call. Inspect normalizedQuery. Plain text and quoted literal parentheses retain their existing meaning. Size/date predicates only match known cached properties; unsupported or conflicting conditions are rejected.'},
  favorites:{commands:['fe favorites list --json','fe favorites add /absolute/file.wav','fe favorites remove /absolute/file.wav'],filters:['favorites:true ext:wav','is:favorite size:1m..10m','view:working','view:all','omit:system;generated;hidden'],notes:'Favorites use the native app shared pins.json. Visibility filters do not remove indexed paths. App and Raycast use view:smart by default, hiding system/generated/hidden/artifact paths and prioritizing useful documents/media; CLI searches keep all paths unless explicitly filtered.'},
  columnFilters:{sorts:['relevance','name','name-desc','path','path-desc','big','small','new','old'],examples:['name:"laser blast"','in:"/Users/me/My Sounds" ext:wav;mp3','size:=0','size:1m..10m','dm:14d'],notes:'Column filters combine across the index before pagination. Size ranges include both endpoints. Explicit name/path/size/date sorts order semantic candidates; sort:relevance or no sort keeps acoustic ranking.'},
  examples: ["engine ext:ts sort:name","ext:pdf dm:week sort:new","size:>100m sort:big","(kurze düstere Lasersounds)", '(Lasersounds unter 500 ms) ext:wav', 'sound:"dark eerie laser sound effect" duration:<1s', "audio: duration:<1s", "alle meine sounds die unter 1 sekunde gehen", "audio: duration:100ms..1s channels:1", "audio: samplerate:>=44.1k", "image: width:>=1920", "engine ext:ts !test"],
  mediaFields: Object.keys(MEDIA_FIELDS),
  notes: "Filename/path searches count the whole indexed snapshot and return stable pages. sort:name|path|new|old|big|small applies globally; size/date require fe properties --index NAME. fe prepare --index NAME builds the accelerator from saved paths without a folder traversal. Pass nextOffset as offset and retain snapshotId. Index gaps, changed settings and unknown properties keep complete false. Parentheses opt into a deterministic German/English audio dictionary: kurz means duration:<1s. Inspect normalizedQuery. sound:\"description\" ranks cached local CLAP audio, without query-time decoding. Semantic recall is approximate. Setup: fe semantic setup; analyze explicitly with fe semantic index. Media fields require fe enrich --index NAME. No file-content index.",
};
