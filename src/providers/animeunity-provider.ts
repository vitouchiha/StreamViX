import { spawn } from 'child_process';
import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeUnityConfig, StreamForStremio } from '../types/animeunity';
import * as path from 'path';
import axios from 'axios';
import { checkIsAnimeById } from '../utils/animeGate';

// Helper function to invoke the Python scraper
async function invokePythonScraper(args: string[]): Promise<any> {
    const scriptPath = path.join(__dirname, 'animeunity_scraper.py');
    
    // Use python3, ensure it's in the system's PATH
    const command = 'python3';

    return new Promise((resolve, reject) => {
        const pythonProcess = spawn(command, [scriptPath, ...args]);

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', (code: number) => {
            if (code !== 0) {
                console.error(`Python script exited with code ${code}`);
                console.error(stderr);
                return reject(new Error(`Python script error: ${stderr}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                console.error('Failed to parse Python script output:');
                console.error(stdout);
                reject(new Error('Failed to parse Python script output.'));
            }
        });

        pythonProcess.on('error', (err: Error) => {
            console.error('Failed to start Python script:', err);
            reject(err);
        });
    });
}

interface AnimeUnitySearchResult {
    id: number;
    slug: string;
    name: string;
    episodes_count: number;
}

interface AnimeUnityEpisode {
    id: number;
    number: string;
    name?: string;
}

interface AnimeUnityStreamData {
    episode_page: string;
    embed_url: string;
    mp4_url: string;
}

// Funzione universale per ottenere il titolo inglese da qualsiasi ID
// Aggiunto fallback Kitsu diretto (titles.en) se manca MAL mapping, come in AnimeSaturn
async function getEnglishTitleFromAnyId(id: string, type: 'imdb'|'tmdb'|'kitsu'|'mal', tmdbApiKey?: string): Promise<string> {
  let malId: string | null = null;
  let tmdbId: string | null = null;
  let fallbackTitle: string | null = null;
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
  if (type === 'imdb') {
    if (!tmdbKey) throw new Error('TMDB_API_KEY non configurata');
    const imdbIdOnly = id.split(':')[0];
    const { getTmdbIdFromImdbId } = await import('../extractor');
    tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey);
    if (!tmdbId) throw new Error('TMDB ID non trovato per IMDB: ' + id);
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'tmdb') {
    tmdbId = id;
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'kitsu') {
    const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}/mappings`)).json();
    const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
    malId = malMapping?.attributes?.externalId?.toString() || null;
    if (!malId) {
      // Fallback: usa direttamente titles.en dal record principale se disponibile
      try {
        const kitsuMain = await (await fetch(`https://kitsu.io/api/edge/anime/${id}`)).json();
        const enTitle = kitsuMain?.data?.attributes?.titles?.en;
        if (enTitle) {
          console.log(`[UniversalTitle][KitsuFallback] Titolo inglese diretto da Kitsu (no MAL mapping): ${enTitle}`);
          return enTitle;
        } else {
          console.warn(`[UniversalTitle][KitsuFallback] Nessun titles.en disponibile per Kitsu ${id}`);
        }
      } catch (e) {
        console.warn(`[UniversalTitle][KitsuFallback] Errore recuperando titles.en per Kitsu ${id}:`, e);
      }
    }
  } else if (type === 'mal') {
    malId = id;
  }
  if (malId) {
    try {
      const jikanResp = await (await fetch(`https://api.jikan.moe/v4/anime/${malId}`)).json();
      let englishTitle = '';
      if (jikanResp.data && Array.isArray(jikanResp.data.titles)) {
        const en = jikanResp.data.titles.find((t: any) => t.type === 'English');
        englishTitle = en?.title || '';
      }
      if (!englishTitle && jikanResp.data) {
        englishTitle = jikanResp.data.title_english || jikanResp.data.title || jikanResp.data.title_japanese || '';
      }
      if (englishTitle) {
        console.log(`[UniversalTitle] Titolo inglese trovato da Jikan: ${englishTitle}`);
        return englishTitle;
      }
    } catch (err) {
      console.warn('[UniversalTitle] Errore Jikan, provo fallback TMDB:', err);
    }
  }
  if (tmdbId && tmdbKey) {
    try {
      let tmdbResp = await (await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`)).json();
      if (tmdbResp && tmdbResp.name) {
        fallbackTitle = tmdbResp.name;
      }
      if (!fallbackTitle) {
        tmdbResp = await (await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`)).json();
        if (tmdbResp && tmdbResp.title) {
          fallbackTitle = tmdbResp.title;
        }
      }
      if (fallbackTitle) {
        console.warn(`[UniversalTitle] Fallback: uso titolo da TMDB: ${fallbackTitle}`);
        return fallbackTitle;
      }
    } catch (err) {
      console.warn('[UniversalTitle] Errore fallback TMDB:', err);
    }
  }
  throw new Error('Impossibile ottenere titolo inglese da nessuna fonte per ' + id);
}

function filterAnimeResults(results: { version: AnimeUnitySearchResult; language_type: string }[], englishTitle: string) {
  // LOGICA LEGACY: accetta solo match esatti (base) + varianti (ita/cr)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const base = norm(englishTitle);
  const allowed = [
    base,
    `${base} (ita)`,
    `${base} (cr)`,
    `${base} (ita) (cr)`
  ];
  const isAllowed = (title: string) => {
    const t = norm(title.replace(/\s*\([^)]*\)/g, m => m.toLowerCase()));
    return allowed.some(a => t === a);
  };
  const filtered = results.filter(r => isAllowed(r.version.name));
  console.log(`[UniversalTitle][Filter][Legacy] Risultati prima del filtro:`, results.map(r => r.version.name));
  console.log(`[UniversalTitle][Filter][Legacy] Risultati dopo il filtro:`, filtered.map(r => r.version.name));
  return filtered;
}

// ==== AUTO-NORMALIZATION-EXACT-MAP-START ====
const exactMap: Record<string,string> = {

    "Attack on Titan: Final Season - The Final Chapters": "Attack on Titan Final Season THE FINAL CHAPTERS Special 1",
    "Attack on Titan: The Final Season - Final Chapters Part 2": "Attack on Titan Final Season THE FINAL CHAPTERS Special 2",   

    // << AUTO-INSERT-EXACT >> (non rimuovere questo commento)
};
// ==== AUTO-NORMALIZATION-EXACT-MAP-END ====

// ==== AUTO-NORMALIZATION-GENERIC-MAP-START ====
const genericMap: Record<string,string> = {


  // << AUTO-INSERT-GENERIC >> (non rimuovere questo commento)
  // Qui puoi aggiungere altre normalizzazioni custom
};
// ==== AUTO-NORMALIZATION-GENERIC-MAP-END ====

// Funzione di normalizzazione per la ricerca (fase base + generic)
function normalizeTitleForSearch(title: string): string {
  // Se exact map colpisce il titolo originale, usiamo direttamente il valore e saltiamo tutto il resto.
  if (Object.prototype.hasOwnProperty.call(exactMap, title)) {
    const mapped = exactMap[title];
    console.log(`[AnimeUnity][ExactMap] Hit: "${title}" -> "${mapped}"`);
    return mapped;
  }
  // LOGICA LEGACY per i NON exact: usare un dizionario di replacements statico (come vecchio codice)
  const replacements: Record<string, string> = {
    'Season': '',
    'Shippuuden': 'Shippuden',
    '-': '',
    'Ore dake Level Up na Ken': 'Solo Leveling',
  };
  let normalized = title;
  for (const [key, value] of Object.entries(replacements)) {
    if (normalized.includes(key)) {
      normalized = normalized.replace(new RegExp(key, 'gi'), value);
    }
  }
  if (normalized.includes('Naruto:')) {
    normalized = normalized.replace(':', '');
  }
  return normalized.trim();
}

export class AnimeUnityProvider {
  private kitsuProvider = new KitsuProvider();

  constructor(private config: AnimeUnityConfig) {}

  private get baseHost(): string { return getDomain('animeunity') || 'animeunity.so'; }

  // Made public for catalog search
  async searchAllVersions(title: string): Promise<{ version: AnimeUnitySearchResult; language_type: string }[]> {
      try {
        const subPromise = invokePythonScraper(['search', '--query', title]).catch(() => []);
        const dubPromise = invokePythonScraper(['search', '--query', title, '--dubbed']).catch(() => []);

        const [subResults, dubResults]: [AnimeUnitySearchResult[], AnimeUnitySearchResult[]] = await Promise.all([subPromise, dubPromise]);
        const results: { version: AnimeUnitySearchResult; language_type: string }[] = [];

        console.log(`[AnimeUnity] Risultati SUB per "${title}":`, subResults?.length || 0);
        console.log(`[AnimeUnity] Risultati DUB per "${title}":`, dubResults?.length || 0);

        // Unisci tutti i risultati (SUB e DUB), ma assegna ITA o CR se il nome contiene
        const allResults = [...(subResults || []), ...(dubResults || [])];
        // Filtra duplicati per nome e id
        const seen = new Set();
        for (const r of allResults) {
          if (!r || !r.name || !r.id) continue;
          const key = r.name + '|' + r.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const nameLower = r.name.toLowerCase();
          let language_type = 'SUB ITA';
          if (nameLower.includes('cr')) {
            language_type = 'CR ITA';
          } else if (nameLower.includes('ita')) {
            language_type = 'ITA';
          }
          results.push({ version: r, language_type });
        }
        console.log(`[AnimeUnity] Risultati totali dopo filtro duplicati:`, results.length);
        return results;
      } catch (error) {
        console.error(`[AnimeUnity] Errore in searchAllVersions per "${title}":`, error);
        return [];
      }
  }

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }

    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling Kitsu request:', error);
      return { streams: [] };
    }
  }

  /**
   * Gestisce la ricerca AnimeUnity partendo da un ID MAL (mal:ID[:STAGIONE][:EPISODIO])
   */
  async handleMalRequest(malIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const parts = malIdString.split(':');
      if (parts.length < 2) throw new Error('Formato MAL ID non valido. Usa: mal:ID o mal:ID:EPISODIO o mal:ID:STAGIONE:EPISODIO');
      const malId = parts[1];
      let seasonNumber: number | null = null;
      let episodeNumber: number | null = null;
      let isMovie = false;
      if (parts.length === 2) {
        isMovie = true;
      } else if (parts.length === 3) {
        episodeNumber = parseInt(parts[2]);
      } else if (parts.length === 4) {
        seasonNumber = parseInt(parts[2]);
        episodeNumber = parseInt(parts[3]);
      }
      const englishTitle = await getEnglishTitleFromAnyId(malId, 'mal', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling MAL request:', error);
      return { streams: [] };
    }
  }

  async handleImdbRequest(imdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('imdb', imdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeUnity] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for ${imdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
  console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch (error) {
      console.error('Error handling IMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('tmdb', tmdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeUnity] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for TMDB ${tmdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
  console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    const normalizedTitle = normalizeTitleForSearch(title);
    console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}`);
    // Se il titolo originale è una chiave dell'exactMap allora saltiamo qualsiasi filtro successivo:
    // l'intento dell'utente è: se la ricerca parte da una chiave exactMap, NON applicare filterAnimeResults
    const skipFilter = Object.prototype.hasOwnProperty.call(exactMap, title);
    if (skipFilter) {
      console.log(`[AnimeUnity][ExactMap] Skip filtro: titolo di input corrisponde a chiave exactMap -> "${title}"`);
    }
    let animeVersions = await this.searchAllVersions(normalizedTitle);
    // Fallback: se non trova nulla, prova anche con titoli alternativi
    if (!animeVersions.length) {
      // Prova a ottenere titoli alternativi da Jikan (se hai il MAL ID)
      let fallbackTitles: string[] = [];
      try {
        // Prova a estrarre MAL ID dal titolo (se è un numero)
        const malIdMatch = title.match && title.match(/\d+/);
        const malId = malIdMatch ? malIdMatch[0] : null;
        if (malId) {
          const jikanResp = await (await fetch(`https://api.jikan.moe/v4/anime/${malId}`)).json();
          fallbackTitles = [
            jikanResp.data?.title_japanese,
            jikanResp.data?.title,
            jikanResp.data?.title_english
          ].filter(Boolean);
        }
      } catch {}
      // Prova fallback con titoli alternativi
      for (const fallbackTitle of fallbackTitles) {
        if (fallbackTitle && fallbackTitle !== normalizedTitle) {
          animeVersions = await this.searchAllVersions(fallbackTitle);
          if (animeVersions.length) break;
        }
      }
      // Fallback: senza apostrofi
      if (!animeVersions.length && normalizedTitle.includes("'")) {
        const noApos = normalizedTitle.replace(/'/g, "");
        animeVersions = await this.searchAllVersions(noApos);
      }
      // Fallback: senza parentesi
      if (!animeVersions.length && normalizedTitle.includes("(")) {
        const noParens = normalizedTitle.split("(")[0].trim();
        animeVersions = await this.searchAllVersions(noParens);
      }
      // Fallback: prime 3 parole
      if (!animeVersions.length) {
        const words = normalizedTitle.split(" ");
        if (words.length > 3) {
          const first3 = words.slice(0, 3).join(" ");
          animeVersions = await this.searchAllVersions(first3);
        }
      }
    }
    if (!skipFilter) {
      animeVersions = filterAnimeResults(animeVersions, normalizedTitle);
    } else {
      console.log('[AnimeUnity][ExactMap] Uso risultati grezzi senza filtro (exactMap).');
    }
    if (!animeVersions.length) {
      console.warn('[AnimeUnity] Nessun risultato trovato per il titolo:', normalizedTitle);
      return { streams: [] };
    }
    const streams: StreamForStremio[] = [];
    const seenLinks = new Set();
    for (const { version, language_type } of animeVersions) {
      const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
      // Filtra undefined e episodi nulli
      const validEpisodes = (episodes || []).filter(e => e && e.id && e.number);
      if (!validEpisodes.length) {
        console.warn(`[AnimeUnity] Nessun episodio valido trovato per la richiesta: S${seasonNumber}E${episodeNumber} (${version.name})`);
        continue;
      }
      let targetEpisode: AnimeUnityEpisode | undefined;
      if (isMovie) {
        targetEpisode = validEpisodes[0];
        console.log(`[AnimeUnity] Selezionato primo episodio (movie):`, targetEpisode?.name);
      } else if (episodeNumber != null) {
        targetEpisode = validEpisodes.find(ep => String(ep.number) === String(episodeNumber));
        console.log(`[AnimeUnity] Episodio selezionato per E${episodeNumber}:`, targetEpisode?.name);
      } else {
        targetEpisode = validEpisodes[0];
        console.log(`[AnimeUnity] Selezionato primo episodio (default):`, targetEpisode?.name);
      }
      if (!targetEpisode) {
        console.warn(`[AnimeUnity] Nessun episodio trovato per la richiesta: S${seasonNumber}E${episodeNumber} (${version.name})`);
        continue;
      }
      const streamResult: AnimeUnityStreamData = await invokePythonScraper([
        'get_stream',
        '--anime-id', String(version.id),
        '--anime-slug', version.slug,
        '--episode-id', String(targetEpisode.id)
      ]);
      if (streamResult.mp4_url) {
        const mediaFlowUrl = formatMediaFlowUrl(
          streamResult.mp4_url,
          this.config.mfpUrl,
          this.config.mfpPassword
        );
        const cleanName = version.name
          .replace(/\s*\(ITA\)/i, '')
          .replace(/\s*\(CR\)/i, '')
          .replace(/ITA/gi, '')
          .replace(/CR/gi, '')
          .trim();
  const sNum = seasonNumber || 1;
  const langLabel = language_type === 'ITA' ? 'ITA' : 'SUB';
  let streamTitle = `${capitalize(cleanName)} ▪ ${langLabel} ▪ S${sNum}`;
        if (episodeNumber) {
          streamTitle += `E${episodeNumber}`;
        }
        // Filtra duplicati per url
        if (!seenLinks.has(mediaFlowUrl)) {
          streams.push({
            title: streamTitle,
            url: mediaFlowUrl,
            behaviorHints: {
              notWebReady: true
            }
          });
          seenLinks.add(mediaFlowUrl);
        }
      }
    }
    return { streams };
  }
}

// Funzione di utilità per capitalizzare la prima lettera
function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
