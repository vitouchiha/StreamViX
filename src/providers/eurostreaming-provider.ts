// thanks @urlomithus for the code https://github.com/UrloMythus/MammaMia
/// <reference types="node" />
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { ChildProcessWithoutNullStreams } from 'child_process';

// Risoluzione Python (Opzione B): prova una lista ordinata e verifica con spawnSync.
let cachedPythonCmd: string | null = null;
function resolvePython(): string {
  if (cachedPythonCmd) return cachedPythonCmd;
  const sentinel = path.join(__dirname, '..', '..', '.es_pycmd');
  try {
    if (fs.existsSync(sentinel)) {
      const saved = fs.readFileSync(sentinel, 'utf-8').trim();
      if (saved) {
        const test = spawnSync(saved, ['-c','import sys;print("ok")'], { timeout: 1200 });
        if (test.status === 0 && test.stdout.toString().includes('ok')) {
          cachedPythonCmd = saved;
          return cachedPythonCmd;
        }
      }
    }
  } catch { /* ignore */ }
  const candidates = [
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    'python3',
    'python'
  ];
  for (const cand of candidates) {
    try {
      if (cand.startsWith('/') && !fs.existsSync(cand)) continue;
      const r = spawnSync(cand, ['-c', 'import sys;print("ok")'], { timeout: 1500 });
      if (r.status === 0 && r.stdout.toString().includes('ok')) {
        cachedPythonCmd = cand;
        try { fs.writeFileSync(sentinel, cand); } catch {}
        console.log('[Eurostreaming][PY] candidate ok ->', cand);
        return cachedPythonCmd;
      }
      console.log('[Eurostreaming][PY] candidate fail code', r.status, cand);
    } catch (e) {
      console.log('[Eurostreaming][PY] candidate error', cand, (e as Error).message);
    }
  }
  console.warn('[Eurostreaming][PY] nessun python funzionante trovato, uso python3 (potrebbe fallire)');
  cachedPythonCmd = 'python3';
  return cachedPythonCmd;
}
import type { StreamForStremio } from '../types/animeunity';

export interface EurostreamingConfig { enabled: boolean; mfpUrl?: string; mfpPassword?: string; tmdbApiKey?: string; }

interface PyResult { streams?: Array<{ url: string; title?: string; player?: string; size?: string; res?: string; lang?: string; match_pct?: number|null }>; error?: string }

// Central runner with enhanced python binary discovery & debug
function runPythonEuro(argsObj: { imdb?: string; tmdb?: string; season?: number|null; episode?: number|null; mfp: boolean; isMovie: boolean; tmdbKey?: string }, timeoutMs = 60000): Promise<PyResult> {
  const script = path.join(__dirname, 'eurostreaming.py');
  return new Promise((resolve) => {
    let finished = false; let stdout = ''; let stderr = '';
    const args: string[] = [];
    if (argsObj.imdb) args.push('--imdb', argsObj.imdb);
    if (argsObj.tmdb) args.push('--tmdb', argsObj.tmdb);
    if (argsObj.season != null) args.push('--season', String(argsObj.season));
    if (argsObj.episode != null) args.push('--episode', String(argsObj.episode));
    if (argsObj.isMovie) args.push('--movie');
    if (argsObj.tmdbKey) args.push('--tmdbKey', argsObj.tmdbKey);
    args.push('--mfp', argsObj.mfp ? '1':'0');
    // Enable debug diagnostics if env flag set
    if ((process.env.ES_DEBUG || '').match(/^(1|true|on)$/i)) args.push('--debug','1');
    console.log('[Eurostreaming][PY] spawn', script, args.join(' '));
    const start = Date.now();
    const pythonCmd = resolvePython();
    console.log('[Eurostreaming][PY] resolved pythonCmd =', pythonCmd);
    // Log python version (non bloccante)
    try {
      const verProc = spawn(pythonCmd, ['-V']);
      let vOut='';
      verProc.stdout.on('data',(d: Buffer)=> vOut+=d.toString());
      verProc.stderr.on('data',(d: Buffer)=> vOut+=d.toString());
      verProc.on('close', ()=> console.log('[Eurostreaming][PY] version', vOut.trim()));
    } catch {}
    // Esegue direttamente senza install runtime (ci affidiamo al container)
      const py = spawn(pythonCmd, [script, ...args]);
      const killer = setTimeout(()=>{ if(!finished){ finished = true; try{py.kill('SIGKILL');}catch{}; resolve({ error: 'timeout' }); } }, timeoutMs);
  py.stdout.on('data', (d: Buffer)=> { const chunk = d.toString(); stdout += chunk; });
  py.stderr.on('data', (d: Buffer)=> { const chunk = d.toString(); stderr += chunk; });
      py.on('close', (code: number) => { if(finished) return; finished = true; clearTimeout(killer); const dur = Date.now()-start; if(code!==0){ console.error('[Eurostreaming][PY] exit', code, 'dur=',dur,'ms stderr_head=', stderr.slice(0,400)); return resolve({ error: stderr || 'exit '+code }); }
        try {
          console.log('[Eurostreaming][PY] raw stdout length', stdout.length);
          const parsed = JSON.parse(stdout);
          console.log('[Eurostreaming][PY] parsed streams', parsed.streams ? parsed.streams.length : 0);
          if ((!parsed.streams || !parsed.streams.length) && (parsed as any).diag) {
            console.log('[Eurostreaming][PY][diag]', JSON.stringify((parsed as any).diag));
          }
          resolve(parsed);
        } catch(e){ console.error('[Eurostreaming][PY] parse error', e, 'stdout_head=', stdout.slice(0,400)); resolve({ error: 'parse error' }); } });
      py.on('error', (err: Error) => { if(finished) return; finished = true; clearTimeout(killer); console.error('[Eurostreaming][PY] proc err', err); resolve({ error: 'proc error' }); });
  });
}

export class EurostreamingProvider {
  constructor(private config: EurostreamingConfig) {}

  private formatStreams(list: PyResult['streams']): StreamForStremio[] {
    if (!list) return [];
  // Mostra sempre entrambi gli host (DeltaBit + MixDrop). Ordina con DeltaBit prima.
  const ordered = [...list].sort((a,b)=>{
    const aDelta = a.url && /deltabit|\/delta\//i.test(a.url) ? 1:0;
    const bDelta = b.url && /deltabit|\/delta\//i.test(b.url) ? 1:0;
    if (aDelta !== bDelta) return bDelta - aDelta; // DeltaBit first
    return 0;
  });
  const out: StreamForStremio[] = [];
  const seen = new Set<string>();
  for (const s of ordered) {
      if (!s.url) continue;
      let line1: string;
      if (s.title) line1 = s.title.split('\n')[0]; else line1 = 'Eurostreaming';
      // Language labeling exactly like MammaMia: ITA uses [ITA], subbed uses [SUB ITA]
      let lang = (s.lang||'ita').toLowerCase();
      // Extra detection: if not already sub, inspect raw title/URL for subtitle markers
      if (lang !== 'sub') {
        const rawLower = (s.title||'').toLowerCase();
        const urlLower = s.url.toLowerCase();
        if (/\bsub(?![a-z])|sub[ ._-]?ita|ita[ ._-]?sub|sottotit|subs?\b/.test(rawLower) || /sub/i.test(urlLower)) {
          lang = 'sub';
        }
      }
      const rawTitleLower = (s.title||'').toLowerCase();
      const hasSubMarker = /\bsub(?![a-z])|sub[ ._-]?ita|ita[ ._-]?sub|sottotit|subs?\b/.test(rawTitleLower);
      if (lang === 'sub' || hasSubMarker) {
        lang = 'sub';
        if (!/\[SUB ITA\]/i.test(line1)) line1 = line1.replace(/\s*\[(SUB )?ITA\]$/i,'').trim()+ ' • [SUB ITA]';
      } else {
        if (!/\[ITA\]/i.test(line1)) line1 = line1.replace(/\s*\[(SUB )?ITA\]$/i,'').trim()+ ' • [ITA]';
      }
      const langTag = lang === 'sub' ? '[SUB ITA]' : '[ITA]';
  // Percentuale match rimossa (non richiesta più)
  const pct = '';
  // Second line format: [LANG] • Player (senza percentuale)
      // Regola: se l'URL contiene dominio mixdrop -> mostra "Mixdrop" altrimenti mantieni player originale (default Deltabit)
      let playerName = s.player ? s.player : 'Deltabit';
      let finalUrl = s.url;
      try {
        const uObj = new URL(s.url);
        const h = uObj.host.toLowerCase();
        if (h.includes('mixdrop')) {
          playerName = 'Mixdrop';
          // Se configurato MFP, wrappiamo l'URL mixdrop nell'extractor
          if (this.config.mfpUrl && this.config.mfpPassword) {
            const base = this.config.mfpUrl.replace(/\/$/, '');
            const encoded = encodeURIComponent(s.url);
            const pass = encodeURIComponent(this.config.mfpPassword);
            finalUrl = `${base}/extractor/video?host=Mixdrop&api_password=${pass}&d=${encoded}&redirect_stream=true`;
          }
        } else if (/deltabit|\/delta\//i.test(s.url)) {
          playerName = 'Deltabit';
        }
      } catch { /* ignore parse */ }
  const second = `${langTag} • ${playerName}`;
      const title = `${line1}\n${second}`;
  if (seen.has(finalUrl)) continue;
  seen.add(finalUrl);
  out.push({ url: finalUrl, title, behaviorHints: { notWebReady: true } });
    }
    return out;
  }

  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) { console.log('[Eurostreaming] provider disabled'); return { streams: [] }; }
    try {
      console.log('[Eurostreaming] handleImdbRequest imdbId=', imdbId, 'season=', season, 'episode=', episode, 'isMovie=', isMovie);
      const py = await runPythonEuro({ imdb: imdbId, season, episode, mfp: !!(this.config.mfpUrl && this.config.mfpPassword), isMovie, tmdbKey: this.config.tmdbApiKey });
      console.log('[Eurostreaming] python result keys=', Object.keys(py||{}));
      const formatted = this.formatStreams(py.streams);
      console.log('[Eurostreaming] formatted count=', formatted.length);
      if (!formatted.length) console.log('[Eurostreaming] EMPTY after formatting original_count=', py.streams ? py.streams.length : 0);
      return { streams: formatted };
    } catch (e) {
      console.error('[Eurostreaming] imdb handler error', e); return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) { console.log('[Eurostreaming] provider disabled'); return { streams: [] }; }
    try {
      console.log('[Eurostreaming] handleTmdbRequest tmdbId=', tmdbId, 'season=', season, 'episode=', episode, 'isMovie=', isMovie);
      const py = await runPythonEuro({ tmdb: tmdbId, season, episode, mfp: !!(this.config.mfpUrl && this.config.mfpPassword), isMovie, tmdbKey: this.config.tmdbApiKey });
      console.log('[Eurostreaming] python result keys=', Object.keys(py||{}));
      const formatted = this.formatStreams(py.streams);
      console.log('[Eurostreaming] formatted count=', formatted.length);
      if (!formatted.length) console.log('[Eurostreaming] EMPTY after formatting original_count=', py.streams ? py.streams.length : 0);
      return { streams: formatted };
    } catch (e) { console.error('[Eurostreaming] tmdb handler error', e); return { streams: [] }; }
  }
}
