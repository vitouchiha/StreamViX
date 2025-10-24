export interface AnimeUnityConfig {
  mfpUrl: string;
  mfpPassword: string;
  enabled: boolean;
  tmdbApiKey?: string;
  animeunityAuto?: boolean; // toggle AUTO master playlist
  animeunityFhd?: boolean;  // toggle FHD only variant
}

export interface AnimeUnityResult {
  id: number;
  slug: string;
  name: string;
  episodes_count: number;
  language_type: 'Original' | 'Italian Dub' | 'Italian Sub';
}

export interface AnimeUnityEpisode {
  id: number;
  number: number;
  name: string;
}

export interface StreamData {
  embed_url?: string;
  mp4_url?: string;
  episode_page?: string;
}

export interface KitsuAnime {
  id: string;
  attributes: {
    titles: {
      en?: string;
      ja_jp?: string;
    };
    canonicalTitle: string;
    startDate: string;
  };
}

// ✅ AGGIUNTO: Export mancante
export interface StreamForStremio {
  title: string;
  url: string;
  behaviorHints: {
    notWebReady?: boolean;
    [key: string]: any;
  };
  isSyntheticFhd?: boolean; // align with VixSrc synthetic FHD flag for provider label badge
}

export interface AnimeSaturnConfig {
  mfpUrl: string;
  mfpPassword: string;
  mfpProxyUrl: string;  // Aggiunto per supportare m3u8 proxy
  mfpProxyPassword: string;  // Aggiunto per supportare m3u8 proxy
  enabled: boolean;
  tmdbApiKey?: string;
}

export interface AnimeSaturnResult {
  title: string;
  url: string;
}

export interface AnimeSaturnEpisode {
  title: string;
  url: string;
}

// === AnimeWorld ===
export interface AnimeWorldConfig {
  mfpUrl: string;
  mfpPassword: string;
  enabled: boolean;
  tmdbApiKey?: string;
}

export interface AnimeWorldResult {
  id: string; // could be slug or numeric id
  slug: string;
  name: string;
  episodes_count: number;
  language_type?: string; // inferred (ITA, SUB ITA, CR ITA, ORIGINAL)
}

export interface AnimeWorldEpisode {
  id: string; // episode identifier
  number: number;
  name?: string;
}
