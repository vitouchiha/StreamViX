import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { AnimeWorldProvider } from './providers/animeworld-provider';
import { KitsuProvider } from './providers/kitsu';
import { formatMediaFlowUrl } from './utils/mediaflow';
import { mergeDynamic, loadDynamicChannels, purgeOldDynamicEvents, invalidateDynamicChannels, getDynamicFilePath, getDynamicFileStats } from './utils/dynamicChannels';

// --- Lightweight declarations to avoid TS complaints if @types/node non installati ---
// (Non sostituiscono l'uso consigliato di @types/node, ma evitano errori bloccanti.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const global: any;
import { AnimeUnityConfig } from "./types/animeunity";
import { EPGManager } from './utils/epg';
import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';
import { fetchPage } from './providers/flaresolverr';

// ================= TYPES & INTERFACES =================
interface AddonConfig {
    tmdbApiKey?: string;
    mediaFlowProxyUrl?: string;
    mediaFlowProxyPassword?: string;
    enableMpd?: boolean;
    animeunityEnabled?: boolean;
    animesaturnEnabled?: boolean;
    animeworldEnabled?: boolean;
    guardaserieEnabled?: boolean;
    guardahdEnabled?: boolean;
    eurostreamingEnabled?: boolean;
    streamingwatchEnabled?: boolean; // nuovo toggle provider StreamingWatch
    disableLiveTv?: boolean;
    disableVixsrc?: boolean;
    tvtapProxyEnabled?: boolean; // true = NO proxy (link diretto TvTap), false = usa proxy se disponibile
    vavooNoMfpEnabled?: boolean; // true = mostra stream Vavoo clean (🏠 / Vavoo🔓), false = nascondi
    cb01Enabled?: boolean; // abilita provider CB01 (Mixdrop only)
    vixLocal?: boolean; // abilita visualizzazione stream diretto VixSrc (checkbox Local)
}

function debugLog(...args: any[]) {
    try {
        console.log('[DEBUG]', ...args);
    } catch {
        // ignore
    }
}

// VAVOO debug switch
// Now ENABLED by default. You can disable with VAVOO_DEBUG=0 or DEBUG_VAVOO=0.
// Set to '1'/'true' to force enable, '0'/'false' to force disable.
const VAVOO_DEBUG: boolean = (() => {
    try {
        const env = (process && process.env) ? process.env : {} as any;
        const norm = (v?: string) => (v || '').toString().trim().toLowerCase();
        const v1 = norm(env.VAVOO_DEBUG);
        const v2 = norm(env.DEBUG_VAVOO);
        if (v1) return !(v1 === '0' || v1 === 'false' || v1 === 'off');
        if (v2) return !(v2 === '0' || v2 === 'false' || v2 === 'off');
        return true; // default ON
    } catch { return true; }
})();
function vdbg(...args: any[]) {
    if (!VAVOO_DEBUG) return;
    try { console.log('[VAVOO-DEBUG]', ...args); } catch { /* ignore */ }
}

// Optional: force using server IP (ignore client IP forwarding) for Vavoo calls
// DEFAULT: ON (use server IP). Disable with VAVOO_FORCE_SERVER_IP=0 or VAVOO_USE_SERVER_IP=0
const VAVOO_FORCE_SERVER_IP: boolean = (() => {
    try {
        const env = (process && process.env) ? process.env : {} as any;
        const norm = (v?: string) => (v || '').toString().trim().toLowerCase();
        const v1 = norm(env.VAVOO_FORCE_SERVER_IP);
        const v2 = norm(env.VAVOO_USE_SERVER_IP);
        if (v1) return !(v1 === '0' || v1 === 'false' || v1 === 'off');
        if (v2) return !(v2 === '0' || v2 === 'false' || v2 === 'off');
        return true; // default ON
    } catch { return true; }
})();

// New: set only ipLocation in ping body to the observed client IP, but DO NOT forward headers
// This keeps transport on server IP while letting Vavoo embed the client IP in addonSig
const VAVOO_SET_IPLOCATION_ONLY: boolean = (() => {
    try {
        const v = (process && process.env && process.env.VAVOO_SET_IPLOCATION_ONLY) ? String(process.env.VAVOO_SET_IPLOCATION_ONLY).toLowerCase() : '';
    if (!v) return true; // default ON
        return !(v === '0' || v === 'false' || v === 'off');
    } catch { return false; }
})();

// Optional: allow full signature logging. Default NOW is FULL (no masking) as requested.
// You can disable with VAVOO_LOG_SIG_FULL=0 (or 'false'/'off').
const VAVOO_LOG_SIG_FULL: boolean = (() => {
    try {
        const env = (process && process.env) ? process.env : {} as any;
        const v = (env.VAVOO_LOG_SIG_FULL || '').toString().trim().toLowerCase();
        if (v === '0' || v === 'false' || v === 'off') return false;
        if (v === '1' || v === 'true' || v === 'on') return true;
        return true; // default ON -> full signature in logs (no masking)
    } catch { return true; }
})();

function maskSig(sig: string, keepStart = 12, keepEnd = 6): string {
    try {
        if (!sig) return '';
        const len = sig.length;
        const head = sig.slice(0, Math.min(keepStart, len));
        const tail = len > keepStart ? sig.slice(Math.max(len - keepEnd, keepStart)) : '';
        const hidden = Math.max(0, len - head.length - tail.length);
        const mask = hidden > 0 ? '*'.repeat(Math.min(hidden, 32)) + (hidden > 32 ? `(+${hidden - 32})` : '') : '';
        return `${head}${mask}${tail}`;
    } catch { return ''; }
}

// === CACHE: Dynamic event stream extraction (per d.url) ===
// Key: `${mfpUrl}|${mfpPsw}|${originalDUrl}` -> { finalUrl, ts }
const dynamicStreamCache = new Map<string, { finalUrl: string; ts: number }>();
const DYNAMIC_STREAM_TTL_MS = 5 * 60 * 1000; // 5 minuti

async function resolveDynamicEventUrl(dUrl: string, providerTitle: string, mfpUrl?: string, mfpPsw?: string): Promise<{ url: string; title: string }> {
    // Se manca proxy config, ritorna immediatamente l'URL originale (fast path)
    if (!mfpUrl || !mfpPsw) return { url: dUrl, title: providerTitle };
    const cacheKey = `${mfpUrl}|${mfpPsw}|${dUrl}`;
    const now = Date.now();
        const cached = dynamicStreamCache.get(cacheKey);
        if (cached && (now - cached.ts) < DYNAMIC_STREAM_TTL_MS) return { url: cached.finalUrl, title: providerTitle };
        const extractorUrl = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=false&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(dUrl)}`;
    try {
        const res = await fetch(extractorUrl);
        if (res.ok) {
            const data = await res.json();
            let finalUrl = data.mediaflow_proxy_url || `${mfpUrl}/proxy/hls/manifest.m3u8`;
            if (data.query_params) {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(data.query_params)) {
                    if (v !== null) params.append(k, String(v));
                }
                finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
            }
            if (data.destination_url) finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'd=' + encodeURIComponent(data.destination_url);
            if (data.request_headers) {
                for (const [hk, hv] of Object.entries(data.request_headers)) {
                    if (hv !== null) finalUrl += '&h_' + hk + '=' + encodeURIComponent(String(hv));
                }
            }
            dynamicStreamCache.set(cacheKey, { finalUrl, ts: now });
            return { url: finalUrl, title: providerTitle };
        } else {
            // Do NOT return extractor/video fallback in dynamic channels; keep original URL instead
            dynamicStreamCache.set(cacheKey, { finalUrl: dUrl, ts: now });
            return { url: dUrl, title: providerTitle };
        }
    } catch {
        // On error, avoid returning extractor/video fallback; expose original URL
        dynamicStreamCache.set(cacheKey, { finalUrl: dUrl, ts: now });
        return { url: dUrl, title: providerTitle };
    }
}

// Global runtime configuration cache (was referenced below)
const configCache: AddonConfig = {};

// === CACHE: Per-request Vavoo clean link (per client_ip + link) ===
const vavooCleanCache = new Map<string, { url: string; ts: number }>();
const VAVOO_CLEAN_TTL_MS = 10 * 60 * 1000; // 10 minuti

function getClientIpFromReq(req: any): string | null {
    try {
        if (!req) return null;
        const hdr = (req.headers || {}) as Record<string, string | string[]>;
        const asStr = (v?: string | string[]) => Array.isArray(v) ? v[0] : (v || '');
        const parseIp = (v?: string) => {
            if (!v) return '';
            let s = v.trim();
            // Forwarded: for="ip:port" or for=ip
            s = s.replace(/^"|"$/g, '');
            // Remove brackets for IPv6
            s = s.replace(/^\[|\]$/g, '');
            // Split possible comma list, take raw first element for further processing outside
            return s;
        };
        const stripPort = (ip: string) => {
            // If IPv4 with :port
            if (ip.includes('.') && ip.includes(':')) return ip.split(':')[0];
            // If IPv6 with :port
            if (ip.includes(':') && ip.lastIndexOf(':') > 1 && ip.indexOf(']') === -1) {
                // best-effort: keep as-is for IPv6 (ports uncommon in headers)
                return ip;
            }
            return ip;
        };
        const isPrivate = (ip: string) => {
            const x = ip.toLowerCase();
            if (!x) return true;
            // IPv6 loopback / unique-local / link-local
            if (x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')) return true;
            // Remove brackets/port
            const y = stripPort(x.replace(/^\[|\]$/g, ''));
            // IPv4 private/reserved ranges
            const m = y.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            if (!m) return false;
            const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a === 10) return true; // 10.0.0.0/8
            if (a === 127) return true; // loopback
            if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
            if (a === 192 && b === 168) return true; // 192.168.0.0/16
            if (a === 169 && b === 254) return true; // link-local
            return false;
        };
        const pickFirstPublic = (list: string[]): string | null => {
            for (const raw of list) {
                const ip = stripPort(raw.replace(/^\[|\]$/g, ''));
                if (ip && !isPrivate(ip)) return ip;
            }
            return list.length ? stripPort(list[0].replace(/^\[|\]$/g, '')) : null;
        };

        // 1) X-Forwarded-For: prefer first public entry
        const xffRaw = asStr(hdr['x-forwarded-for']);
        if (xffRaw) {
            const parts = xffRaw.split(',').map(s => parseIp(s)).map(s => s.trim()).filter(Boolean);
            const chosen = pickFirstPublic(parts);
            if (chosen) { vdbg('IP pick via XFF', { chain: parts, chosen }); return chosen; }
        }
        // 2) True-Client-IP / CF-Connecting-IP / X-Real-IP / X-Client-IP
        const tci = stripPort(parseIp(asStr(hdr['true-client-ip'])));
        if (tci && !isPrivate(tci)) { vdbg('IP pick via True-Client-IP', { tci }); return tci; }
        const cfc = stripPort(parseIp(asStr(hdr['cf-connecting-ip'])));
        if (cfc && !isPrivate(cfc)) { vdbg('IP pick via CF-Connecting-IP', { cfc }); return cfc; }
        const xr = stripPort(parseIp(asStr(hdr['x-real-ip'])));
        if (xr && !isPrivate(xr)) { vdbg('IP pick via X-Real-IP', { xr }); return xr; }
        const xci = stripPort(parseIp(asStr(hdr['x-client-ip'])));
        if (xci && !isPrivate(xci)) { vdbg('IP pick via X-Client-IP', { xci }); return xci; }
        // 3) Forwarded: for=
        const fwd = asStr(hdr['forwarded']);
        if (fwd) {
            const m = fwd.match(/for=([^;]+)/i);
            if (m && m[1]) {
                const candidate = stripPort(parseIp(m[1]));
                if (candidate && !isPrivate(candidate)) { vdbg('IP pick via Forwarded', { candidate }); return candidate; }
            }
        }
        // 4) Express provided (requires trust proxy to be set elsewhere)
    const ips = Array.isArray((req as any).ips) ? (req as any).ips : [];
        if (ips.length) {
            const chosen = pickFirstPublic(ips);
            if (chosen) { vdbg('IP pick via req.ips', { ips, chosen }); return chosen; }
        }
        const ra = (req as any).ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
        if (ra) {
            const v = stripPort(String(ra));
            vdbg('IP pick via remoteAddress/ip (fallback)', { v });
            return v.replace(/^\[|\]$/g, '');
        }
    } catch (e) { try { vdbg('IP detect error', String(e)); } catch {} }
    return null;
}

async function resolveVavooCleanUrl(vavooPlayUrl: string, clientIp: string | null): Promise<{ url: string; headers: Record<string, string> } | null> {
    try {
        if (!vavooPlayUrl || !vavooPlayUrl.includes('vavoo.to')) return null;
        // No cache: always resolve per request using the requester IP
        const startedAt = Date.now();
        vdbg('Clean resolve START', { url: vavooPlayUrl.substring(0, 120), ip: clientIp || '(none)' });

        const controller = new AbortController();
        const to = setTimeout(() => {
            vdbg('Ping timeout -> aborting request');
            controller.abort();
        }, 12000);
    const pingBody = {
            token: 'tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g',
            reason: 'app-blur',
            locale: 'de',
            theme: 'dark',
            metadata: {
                device: { type: 'Handset', brand: 'google', model: 'Pixel', name: 'sdk_gphone64_arm64', uniqueId: 'd10e5d99ab665233' },
                os: { name: 'android', version: '13', abis: ['arm64-v8a','armeabi-v7a','armeabi'], host: 'android' },
                app: { platform: 'android', version: '3.1.21', buildId: '289515000', engine: 'hbc85', signatures: ['6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e'], installer: 'app.revanced.manager.flutter' },
                version: { package: 'tv.vavoo.app', binary: '3.1.21', js: '3.1.21' }
            },
                ipLocation: (clientIp && (!VAVOO_FORCE_SERVER_IP || VAVOO_SET_IPLOCATION_ONLY)) ? clientIp : '',
            playerActive: false,
            playDuration: 0,
            devMode: false,
            hasAddon: true,
            castConnected: false,
            package: 'tv.vavoo.app',
            version: '3.1.21',
            process: 'app',
            firstAppStart: Date.now(),
            lastAppStart: Date.now(),
            adblockEnabled: true,
            proxy: { supported: ['ss','openvpn'], engine: 'ss', ssVersion: 1, enabled: true, autoServer: true, id: 'de-fra' },
            iap: { supported: false }
        } as any;
        const pingHeaders: Record<string, string> = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
    if (clientIp && !VAVOO_FORCE_SERVER_IP) {
            pingHeaders['x-forwarded-for'] = clientIp;
            pingHeaders['x-real-ip'] = clientIp;
            pingHeaders['cf-connecting-ip'] = clientIp;
            // Extra standard/proxy headers to propagate client IP without tampering tokens
            pingHeaders['forwarded'] = `for=${clientIp}`; // RFC 7239
            pingHeaders['true-client-ip'] = clientIp;     // Some CDNs
            pingHeaders['x-client-ip'] = clientIp;        // Legacy
            vdbg('Ping will forward client IP', { xff: clientIp, ipLocation: pingBody.ipLocation });
        } else {
            if (clientIp && VAVOO_SET_IPLOCATION_ONLY) {
                vdbg('Ping ipLocation-only mode: set ipLocation to observed client IP, but using SERVER IP for transport (no forwarding headers).', { observedClientIp: clientIp });
            } else if (clientIp) {
                vdbg('Ping forced to use SERVER IP (no forwarding headers). Observed client IP present but NOT used.', { observedClientIp: clientIp });
            } else {
                vdbg('Ping will use SERVER IP (no client IP observed)');
            }
        }
        vdbg('Ping POST https://www.vavoo.tv/api/app/ping', { ipLocation: pingBody.ipLocation });
        const pingRes = await fetch('https://www.vavoo.tv/api/app/ping', {
            method: 'POST',
            headers: pingHeaders,
            body: JSON.stringify(pingBody),
            signal: controller.signal
        } as any);
        clearTimeout(to);
        vdbg('Ping response', { status: pingRes.status, ok: pingRes.ok, tookMs: Date.now() - startedAt });
        if (!pingRes.ok) {
            let text = '';
            try { text = await pingRes.text(); } catch {}
            vdbg('Ping NOT OK, body snippet:', text.substring(0, 300));
            return null;
        }
    const pingJson = await pingRes.json();
    let addonSig = pingJson?.addonSig as string;
        if (!addonSig) {
            vdbg('Ping OK but addonSig missing. Payload keys:', Object.keys(pingJson || {}));
            return null;
        }
    vdbg('Ping OK, addonSig len:', String(addonSig).length);
    // Show signature in logs (full by default unless disabled)
    const sigPreview = VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig));
    vdbg('Ping OK, addonSig preview:', sigPreview);
    // Decode and REWRITE addonSig: replace ips with client IP, then re-encode (per user request)
    try {
        const decoded = Buffer.from(String(addonSig), 'base64').toString('utf8');
        vdbg('addonSig base64 decoded (truncated):', decoded.substring(0, 500));
        let sigObj: any = null;
        try { sigObj = JSON.parse(decoded); } catch {}
        if (sigObj) {
            let dataObj: any = {};
            try { dataObj = JSON.parse(sigObj?.data || '{}'); } catch {}
            const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
            vdbg('addonSig.data ips (before):', currentIps);
            if (clientIp) {
                // Rewrite IPs to prioritize the observed client IP
                const newIps = [clientIp, ...currentIps.filter((x: any) => x && x !== clientIp)];
                dataObj.ips = newIps;
                if (typeof dataObj.ip === 'string') dataObj.ip = clientIp;
                try {
                    sigObj.data = JSON.stringify(dataObj);
                    const reencoded = Buffer.from(JSON.stringify(sigObj), 'utf8').toString('base64');
                    vdbg('addonSig REWRITTEN with client IP', { oldLen: String(addonSig).length, newLen: String(reencoded).length });
                    vdbg('addonSig.data ips (after):', newIps);
                    addonSig = reencoded;
                } catch (e) {
                    vdbg('addonSig rewrite failed, will use original signature', String(e));
                }
            } else {
                vdbg('No client IP observed, addonSig not rewritten');
            }
        }
    } catch {}

        const controller2 = new AbortController();
        const to2 = setTimeout(() => {
            vdbg('Resolve timeout -> aborting request');
            controller2.abort();
        }, 12000);
    const resolveHeaders: Record<string, string> = { 'user-agent': 'MediaHubMX/2', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': addonSig };
        if (clientIp && !VAVOO_FORCE_SERVER_IP) {
            resolveHeaders['x-forwarded-for'] = clientIp;
            resolveHeaders['x-real-ip'] = clientIp;
            resolveHeaders['cf-connecting-ip'] = clientIp;
            // Extra standard/proxy headers to propagate client IP without tampering tokens
            resolveHeaders['forwarded'] = `for=${clientIp}`; // RFC 7239
            resolveHeaders['true-client-ip'] = clientIp;     // Some CDNs
            resolveHeaders['x-client-ip'] = clientIp;        // Legacy
            vdbg('Resolve will forward client IP', { xff: clientIp, addonSigLen: String(addonSig).length });
        } else {
            if (clientIp) {
                vdbg('Resolve forced to use SERVER IP (no forwarding headers added). Observed client IP present but NOT used.', { addonSigLen: String(addonSig).length, observedClientIp: clientIp });
            } else {
                vdbg('Resolve will use SERVER IP (no client IP observed)', { addonSigLen: String(addonSig).length });
            }
        }
    // Log the signature being sent to resolve (masked by default)
    vdbg('Resolve using signature:', VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig)));
        vdbg('Resolve POST https://vavoo.to/mediahubmx-resolve.json', { url: vavooPlayUrl.substring(0, 120), headers: Object.keys(resolveHeaders) });
        const resolveRes = await fetch('https://vavoo.to/mediahubmx-resolve.json', {
            method: 'POST',
            headers: resolveHeaders,
            body: JSON.stringify({ language: 'de', region: 'AT', url: vavooPlayUrl, clientVersion: '3.1.21' }),
            signal: controller2.signal
        } as any);
        clearTimeout(to2);
        vdbg('Resolve response', { status: resolveRes.status, ok: resolveRes.ok, tookMs: Date.now() - startedAt });
        if (!resolveRes.ok) {
            let text = '';
            try { text = await resolveRes.text(); } catch {}
            vdbg('Resolve NOT OK, body snippet:', text.substring(0, 300));
            return null;
        }
        const resolveJson = await resolveRes.json();
        let resolved: string | null = null;
        if (Array.isArray(resolveJson) && resolveJson.length && resolveJson[0]?.url) resolved = String(resolveJson[0].url);
        else if (resolveJson && typeof resolveJson === 'object' && resolveJson.url) resolved = String(resolveJson.url);
        if (!resolved) {
            vdbg('Resolve OK but no url field in JSON. Shape:', Array.isArray(resolveJson) ? 'array' : typeof resolveJson);
            return null;
        }
        vdbg('Clean resolve SUCCESS', { url: resolved.substring(0, 200) });
        return { url: resolved, headers: { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } };
    } catch (e) {
        const msg = (e as any)?.message || String(e);
        vdbg('Clean resolve ERROR:', msg);
        console.error('[VAVOO] Clean resolve failed:', msg);
        return null;
    }
}

const DEFAULT_VAVOO_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

// Promisify execFile for reuse
const execFilePromise = util.promisify(execFile);

// Placeholder helper for categories; implement real logic later or ensure existing util present
function getChannelCategories(channel: any): string[] {
    if (!channel) return [];
    // Gestione array
    if (Array.isArray(channel.category)) return channel.category.map((c: any) => String(c).toLowerCase());
    if (Array.isArray(channel.categories)) return channel.categories.map((c: any) => String(c).toLowerCase());
    // Gestione stringa singola
    if (typeof channel.category === 'string' && channel.category.trim() !== '') return [channel.category.toLowerCase()];
    if (typeof channel.categories === 'string' && channel.categories.trim() !== '') return [channel.categories.toLowerCase()];
    return [];
}

// Funzioni utility per decodifica base64
function decodeBase64(str: string): string {
    return Buffer.from(str, 'base64').toString('utf8');
}

// Funzione per decodificare URL statici (sempre in base64)
function decodeStaticUrl(url: string): string {
    if (!url) return url;
    console.log(`🔧 [Base64] Decodifica URL (sempre base64): ${url.substring(0, 50)}...`);
    try {
        // Assicura padding corretto (lunghezza multipla di 4)
        let paddedUrl = url;
        while (paddedUrl.length % 4 !== 0) paddedUrl += '=';
        const decoded = decodeBase64(paddedUrl);
        console.log(`✅ [Base64] URL decodificato: ${decoded}`);
        return decoded;
    } catch (error) {
        console.error(`❌ [Base64] Errore nella decodifica: ${error}`);
        console.log(`🔧 [Base64] Ritorno URL originale per errore`);
        return url;
    }
}

// Helper: compute Europe/Rome interpretation for eventStart even if timezone is missing
// ================= MANIFEST BASE (restored) =================
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "7.11.23",
    name: "StreamViX | Elfhosted",
    description: "StreamViX addon con VixSRC, Guardaserie, Altadefinizione, AnimeUnity, AnimeSaturn, AnimeWorld, Eurostreaming, TV ed Eventi Live",
    background: "https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/backround.png",
    types: ["movie", "series", "tv", "anime"],
    idPrefixes: ["tt", "kitsu", "tv", "mal", "tmdb"],
    catalogs: [
        {
            id: "streamvix_tv",
            type: "tv",
            name: "StreamViX TV",
            extra: [
                {
                    name: "genre",
                    options: [
                        "RAI",
                        "Sky",
                        "Sport",
                        "Cinema",
                        "Documentari",
                        "Discovery",
                        "News",
                        "Generali",
                        "Bambini",
                        "Pluto",
                        "Serie A",
                        "Serie B",
                        "Serie C",
                        "Coppe",
                        "Soccer",
                        "Premier League",
                        "Liga",
                        "Bundesliga",
                        "Ligue 1",
                        "Tennis",
                        "F1",
                        "MotoGp",
                        "Basket",
                        "Volleyball",
                        "Ice Hockey",
                        "Wrestling",
                        "Boxing",
                        "Darts",
                        "Baseball",
                        "NFL"
                    ]
                },
                { name: "genre", isRequired: false },
                { name: "search", isRequired: false }
            ]
        }
    ],
    resources: ["stream", "catalog", "meta"],
    behaviorHints: { configurable: true },
    config: [
        { key: "tmdbApiKey", title: "TMDB API Key", type: "text" },
        { key: "mediaFlowProxyUrl", title: "MediaFlow Proxy URL", type: "text" },
        { key: "mediaFlowProxyPassword", title: "MediaFlow Proxy Password", type: "text" },
        // { key: "enableMpd", title: "Enable MPD Streams", type: "checkbox" },
    { key: "disableVixsrc", title: "Disable VixSrc", type: "checkbox" },
    { key: "disableLiveTv", title: "Live TV 📺 [Molti canali hanno bisogno di MFP]", type: "checkbox", default: false },
    { key: "animeunityEnabled", title: "Enable AnimeUnity", type: "checkbox" },
    { key: "animesaturnEnabled", title: "Enable AnimeSaturn", type: "checkbox" },
    { key: "animeworldEnabled", title: "Enable AnimeWorld", type: "checkbox" },
    { key: "guardaserieEnabled", title: "Enable GuardaSerie", type: "checkbox" },
    { key: "guardahdEnabled", title: "Enable GuardaHD", type: "checkbox" },
    { key: "eurostreamingEnabled", title: "Eurostreaming", type: "checkbox" },
    { key: "cb01Enabled", title: "Enable CB01 Mixdrop", type: "checkbox" },
    { key: "streamingwatchEnabled", title: "StreamingWatch 🔓", type: "checkbox" },
    { key: "tvtapProxyEnabled", title: "TvTap NO MFP 🔓", type: "checkbox", default: true },
    { key: "vavooNoMfpEnabled", title: "Vavoo NO MFP 🔓", type: "checkbox", default: true },
    // UI helper toggles (not used directly server-side but drive dynamic form logic)
    { key: "personalTmdbKey", title: "TMDB API KEY Personale", type: "checkbox" },
    { key: "mediaflowMaster", title: "MediaflowProxy", type: "checkbox", default: false },

    ]
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');

        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }

    return baseManifest;
}

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};

    // Se non ci sono args o sono vuoti, ritorna configurazione vuota
    if (!args || args === '' || args === 'undefined' || args === 'null') {
        debugLog('No configuration provided, using defaults');
        return config;
    }

    // Se la configurazione è già un oggetto, usala direttamente
    if (typeof args === 'object' && args !== null) {
        debugLog('Configuration provided as object');
        return args;
    }

    if (typeof args === 'string') {
        debugLog(`Configuration string: ${args.substring(0, 50)}... (length: ${args.length})`);

        // PASSO 1: Prova JSON diretto
        try {
            const parsed = JSON.parse(args);
            debugLog('Configuration parsed as direct JSON');
            return parsed;
        } catch (error) {
            debugLog('Not direct JSON, trying other methods');
        }

        // PASSO 2: Gestione URL encoded
        let decodedArgs = args;
        if (args.includes('%')) {
            try {
                decodedArgs = decodeURIComponent(args);
                debugLog('URL-decoded configuration');

                // Prova JSON dopo URL decode
                try {
                    const parsed = JSON.parse(decodedArgs);
                    debugLog('Configuration parsed from URL-decoded JSON');
                    return parsed;
                } catch (innerError) {
                    debugLog('URL-decoded content is not valid JSON');
                }
            } catch (error) {
                debugLog('URL decoding failed');
            }
        }

        // PASSO 3: Gestione Base64
        if (decodedArgs.startsWith('eyJ') || /^[A-Za-z0-9+\/=]+$/.test(decodedArgs)) {
            try {
                // Fix per caratteri = che potrebbero essere URL encoded
                const base64Fixed = decodedArgs
                    .replace(/%3D/g, '=')
                    .replace(/=+$/, ''); // Rimuove eventuali = alla fine

                // Assicura che la lunghezza sia multipla di 4 aggiungendo = se necessario
                let paddedBase64 = base64Fixed;
                while (paddedBase64.length % 4 !== 0) {
                    paddedBase64 += '=';
                }

                debugLog(`Trying base64 decode: ${paddedBase64.substring(0, 20)}...`);
                const decoded = Buffer.from(paddedBase64, 'base64').toString('utf-8');
                debugLog(`Base64 decoded result: ${decoded.substring(0, 50)}...`);

                if (decoded.includes('{') && decoded.includes('}')) {
                    try {
                        const parsed = JSON.parse(decoded);
                        debugLog('Configuration parsed from Base64');
                        return parsed;
                    } catch (jsonError) {
                        debugLog('Base64 content is not valid JSON');

                        // Prova a estrarre JSON dalla stringa decodificata
                        const jsonMatch = decoded.match(/({.*})/);
                        if (jsonMatch && jsonMatch[1]) {
                            try {
                                const extractedJson = jsonMatch[1];
                                const parsed = JSON.parse(extractedJson);
                                debugLog('Extracted JSON from Base64 decoded string');
                                return parsed;
                            } catch (extractError) {
                                debugLog('Extracted JSON parsing failed');
                            }
                        }
                    }
                }
            } catch (error) {
                debugLog('Base64 decoding failed');
            }
        }

        debugLog('All parsing methods failed, using default configuration');
    }

    return config;
}

// Carica canali TV e domini da file esterni
let tvChannels: any[] = [];
let staticBaseChannels: any[] = [];
let domains: any = {};
let epgConfig: any = {};
let epgManager: EPGManager | null = null;

// ✅ DICHIARAZIONE delle variabili globali del builder
let globalBuilder: any;
let globalAddonInterface: any;
let globalRouter: any;
let lastDisableLiveTvFlag: boolean | undefined;

// === Lightweight watcher state for static tv_channels.json reload ===
let _staticFilePath: string | null = null;
let _staticFileLastMtime = 0;
let _staticFileLastHash = '';
function _computeHash(buf: Buffer): string { try { return crypto.createHash('md5').update(buf).digest('hex'); } catch { return ''; } }
function _resolveStaticPath(): string {
    if (_staticFilePath && fs.existsSync(_staticFilePath)) return _staticFilePath;
    const candidates = [
        path.join(__dirname, '..', 'config', 'tv_channels.json'),
        path.join(process.cwd(), 'config', 'tv_channels.json'),
        path.join(__dirname, 'config', 'tv_channels.json')
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { _staticFilePath = c; return c; } }
    return candidates[0];
}
function _loadStaticChannelsIfChanged(force = false) {
    try {
        const p = _resolveStaticPath();
        if (!fs.existsSync(p)) return;
        const st = fs.statSync(p);
        const mtime = st.mtimeMs;
        if (!force && mtime === _staticFileLastMtime) return; // quick check
        const raw = fs.readFileSync(p);
        const h = _computeHash(raw);
        if (!force && mtime === _staticFileLastMtime && h === _staticFileLastHash) return;
        const parsed = JSON.parse(raw.toString('utf-8'));
        if (!Array.isArray(parsed)) return;
        staticBaseChannels = parsed;
        _staticFileLastMtime = mtime;
        _staticFileLastHash = h;
        // Count pdUrlF present
        let pdCount = 0; let total = parsed.length;
        for (const c of parsed) if (c && c.pdUrlF) pdCount++;
        console.log(`[TV][RELOAD] staticBaseChannels reloaded: total=${total} pdUrlF=${pdCount} mtime=${new Date(mtime).toISOString()} hash=${h.slice(0,12)}`);
    } catch (e) {
        console.warn('[TV][RELOAD] errore reload static tv_channels:', (e as any)?.message || e);
    }
}
// WATCH UNIFICATO: controlla sia static (tv_channels.json) che dynamic (dynamic_channels.json)
//   - Intervallo configurabile con WATCH_INTERVAL_MS (fallback: TV_STATIC_WATCH_INTERVAL_MS / DYNAMIC_WATCH_INTERVAL_MS / 300000)
//   - Static: usa _loadStaticChannelsIfChanged (già fa hash/mtime e log solo se cambia)
//   - Dynamic: calcola mtime+hash e se cambia invalida+reload
(() => {
    try {
        const intervalMs = parseInt(process.env.WATCH_INTERVAL_MS || process.env.TV_STATIC_WATCH_INTERVAL_MS || process.env.DYNAMIC_WATCH_INTERVAL_MS || '300000', 10); // default 5m
        let lastDynMtime = 0; let lastDynHash = '';
        function checkDynamicOnce() {
            try {
                const p = getDynamicFilePath();
                if (!p || !fs.existsSync(p)) return;
                const st = fs.statSync(p);
                const raw = fs.readFileSync(p);
                const h = _computeHash(raw);
                if (st.mtimeMs !== lastDynMtime || h !== lastDynHash) {
                    const oldShort = lastDynHash.slice(0,8);
                    lastDynMtime = st.mtimeMs; lastDynHash = h;
                    invalidateDynamicChannels();
                    const dyn = loadDynamicChannels(true);
                    console.log(`[WATCH][DYN] reload (changed) oldHash=${oldShort} newHash=${h.slice(0,8)} count=${dyn.length}`);
                }
            } catch (e) {
                console.warn('[WATCH][DYN] errore controllo dynamic:', (e as any)?.message || e);
            }
        }
        function loop() {
            try {
                _loadStaticChannelsIfChanged(false);
                checkDynamicOnce();
            } finally {
                // next tick gestito da setInterval
            }
        }
        // primo giro: forziamo static + dynamic
        setTimeout(() => { _loadStaticChannelsIfChanged(true); checkDynamicOnce(); }, 1500);
        setInterval(loop, Math.max(60000, intervalMs));
        console.log(`[WATCH] unificato attivo ogni ${Math.max(60000, intervalMs)}ms (default 5m)`);
    } catch (e) {
        console.log('[WATCH] init failed', (e as any)?.message || e);
    }
})();

// (RIMOSSO) watcher dinamico separato (ora unificato sopra)
// === STREAMED playlist enrichment (spawns external python script) ===
(() => {
    try {
        // Auto-enable STREAMED enrichment if the user hasn't explicitly set STREAMED_ENABLE.
        // Rationale: we want the enrichment active by default (was originally introduced for a test phase).
        let enableRaw = (process.env.STREAMED_ENABLE || '').toString().toLowerCase();
        if (!enableRaw) {
            // default ON in absence of explicit value so that the enrichment always runs unless explicitly disabled
            enableRaw = '1';
            process.env.STREAMED_ENABLE = '1';
            console.log('[STREAMED][INIT] abilitazione automatica');
        }
        const enable = enableRaw;
        if (!['1','true','on','yes'].includes(enable)) return;
    const intervalMs = Math.max(30000, parseInt(process.env.STREAMED_POLL_INTERVAL_MS || '120000', 10)); // default 120s (allineato a RBTV)
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, '..', 'streamed_channels.py');
        if (!fs.existsSync(scriptPath)) { console.log('[STREAMED][INIT] script non trovato', scriptPath); return; }
        function runOnce(tag: string) {
            const env: any = { ...process.env };
            // Propaga percorso dynamic se usato
            try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
            const t0 = Date.now();
            const child = spawn(pythonBin, [scriptPath], { env });
            let out = ''; let err = '';
            child.stdout.on('data', d => { out += d.toString(); });
            child.stderr.on('data', d => { err += d.toString(); });
            child.on('close', code => {
                const ms = Date.now() - t0;
                if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[STREAMED][OUT]', l));
                if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[STREAMED][ERR]', l));
                console.log(`[STREAMED][RUN] done code=${code} ms=${ms}`);
            });
        }
        // Force headers + force mode for initial test run (Bologna vs Genoa) unless user explicitly disables
        const initialEnv = { ...process.env };
        if (!initialEnv.STREAMED_FORCE) initialEnv.STREAMED_FORCE = '1';
        if (!initialEnv.STREAMED_PROPAGATE_HEADERS) initialEnv.STREAMED_PROPAGATE_HEADERS = '1';
        // Kick an immediate run (slight delay to allow Live.py generation) with forced env
        setTimeout(()=>{
            const t0 = Date.now();
            try { initialEnv.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
            const child = spawn(pythonBin, [scriptPath], { env: initialEnv });
            let out=''; let err='';
            child.stdout.on('data', (d: any)=> out+=d.toString());
            child.stderr.on('data', (d: any)=> err+=d.toString());
            child.on('close', (code: any) => {
                const ms = Date.now() - t0;
                if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[STREAMED][OUT][INIT]', l));
                if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[STREAMED][ERR][INIT]', l));
                console.log(`[STREAMED][RUN][INIT] done code=${code} ms=${ms}`);
            });
        }, 5000);
        setInterval(()=>runOnce('loop'), intervalMs);
        console.log('[STREAMED][INIT] abilitato poll ogni', intervalMs,'ms');
    } catch (e) {
        console.log('[STREAMED][INIT][ERR]', (e as any)?.message || e);
    }
})();

// === RBTV (RB77) playlist enrichment ===
(() => {
    try {
        let enableRaw = (process.env.RBTV_ENABLE || '').toString().toLowerCase();
        if (!enableRaw) {
            enableRaw = '1';
            process.env.RBTV_ENABLE = '1';
            console.log('[RBTV][INIT] abilitazione automatica');
        }
        if (!['1','true','on','yes'].includes(enableRaw)) return;
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, '..', 'rbtv_streams.py');
        if (!fs.existsSync(scriptPath)) { console.log('[RBTV][INIT] script non trovato', scriptPath); return; }
        const intervalMs = Math.max(60000, parseInt(process.env.RBTV_POLL_INTERVAL_MS || '120000', 10)); // default 120s
        function runOnce(tag: string) {
            const env: any = { ...process.env };
            try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
            const t0 = Date.now();
            const child = spawn(pythonBin, [scriptPath], { env });
            let out=''; let err='';
            child.stdout.on('data', d=> out+=d.toString());
            child.stderr.on('data', d=> err+=d.toString());
            child.on('close', code => {
                const ms = Date.now() - t0;
                if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[RBTV][OUT]', l));
                if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[RBTV][ERR]', l));
                console.log(`[RBTV][RUN] done code=${code} ms=${ms}`);
            });
        }
        // Primo giro forzato (RBTV_FORCE=1) ritardato per lasciare generare Live.py, simile a STREAMED_FORCE
        setTimeout(()=> {
            try {
                const initialEnv: any = { ...process.env };
                if (!initialEnv.RBTV_FORCE) initialEnv.RBTV_FORCE = '1'; // forza discovery iniziale
                try { initialEnv.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
                const t0 = Date.now();
                const child = spawn(pythonBin, [scriptPath], { env: initialEnv });
                let out=''; let err='';
                child.stdout.on('data', (d: any)=> out+=d.toString());
                child.stderr.on('data', (d: any)=> err+=d.toString());
                child.on('close', (code: any) => {
                    const ms = Date.now() - t0;
                    if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[RBTV][OUT][INIT]', l));
                    if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[RBTV][ERR][INIT]', l));
                    console.log(`[RBTV][RUN][INIT] done code=${code} ms=${ms}`);
                });
            } catch (e) {
                console.log('[RBTV][INIT][FORCE][ERR]', (e as any)?.message || e);
            }
        }, 7000);
        setInterval(()=> runOnce('loop'), intervalMs);
        console.log('[RBTV][INIT] poll ogni', intervalMs, 'ms');
    } catch (e) {
        console.log('[RBTV][INIT][ERR]', (e as any)?.message || e);
    }
})();

// === SPSO (SportsOnline) playlist enrichment ===
(() => {
    try {
        let enableRaw = (process.env.SPSO_ENABLE || '').toString().toLowerCase();
        if (!enableRaw) {
            enableRaw = '1';
            process.env.SPSO_ENABLE = '1';
            console.log('[SPSO][INIT] abilitazione automatica');
        }
        if (!['1','true','on','yes'].includes(enableRaw)) return;
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, '..', 'spso_streams.py');
        if (!fs.existsSync(scriptPath)) { console.log('[SPSO][INIT] script non trovato', scriptPath); return; }
        const intervalMs = Math.max(60000, parseInt(process.env.SPSO_POLL_INTERVAL_MS || '120000', 10));
        function runOnce(tag: string) {
            const env: any = { ...process.env };
            try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
            const t0 = Date.now();
            const child = spawn(pythonBin, [scriptPath], { env });
            let out=''; let err='';
            child.stdout.on('data', d=> out+=d.toString());
            child.stderr.on('data', d=> err+=d.toString());
            child.on('close', code => {
                const ms = Date.now() - t0;
                if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[SPSO][OUT]', l));
                if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[SPSO][ERR]', l));
                console.log(`[SPSO][RUN] done code=${code} ms=${ms}`);
            });
        }
        setTimeout(()=> {
            try {
                const initialEnv: any = { ...process.env };
                if (!initialEnv.SPSO_FORCE) initialEnv.SPSO_FORCE = '1';
                try { initialEnv.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
                const t0 = Date.now();
                const child = spawn(pythonBin, [scriptPath], { env: initialEnv });
                let out=''; let err='';
                child.stdout.on('data', d=> out+=d.toString());
                child.stderr.on('data', d=> err+=d.toString());
                child.on('close', code => {
                    const ms = Date.now() - t0;
                    if (out.trim()) out.split(/\r?\n/).forEach(l=>console.log('[SPSO][OUT][INIT]', l));
                    if (err.trim()) err.split(/\r?\n/).forEach(l=>console.warn('[SPSO][ERR][INIT]', l));
                    console.log(`[SPSO][RUN][INIT] done code=${code} ms=${ms}`);
                });
            } catch (e) {
                console.log('[SPSO][INIT][FORCE][ERR]', (e as any)?.message || e);
            }
        }, 9000); // dopo RBTV per non sovrapporsi all'iniziale RBTV run
        setInterval(()=> runOnce('loop'), intervalMs);
        console.log('[SPSO][INIT] poll ogni', intervalMs, 'ms');
    } catch (e) {
        console.log('[SPSO][INIT][ERR]', (e as any)?.message || e);
    }
})();

// (RIMOSSO) Adaptive windows: sostituito da watcher semplice costante.

// =====================================
// [P🐽D] STARTUP DIAGNOSTICS (container parity)
// Attivabile con env: DIAG_PD=1 (default ON per ora salvo DIAG_PD=0)
// Stampa informazioni su:
//  - Presenza & hash di pig_channels.py
//  - Presenza & hash di config/tv_channels.json
//  - Presenza, size, mtime del dynamic_channels.json selezionato (via getDynamicFilePath)
//  - Conteggio rapida occorrenze label "[P🐽D]" nel dynamic_channels.json (per confermare injection)
// =====================================
(() => {
    try {
        const envVal = (process?.env?.DIAG_PD || '1').toString().toLowerCase();
        if (['0','false','off','no'].includes(envVal)) {
            return; // diagnostics disabilitata
        }
        const root = path.join(__dirname, '..');
        const fileInfo = (rel: string) => {
            const p = path.join(root, rel);
            if (!fs.existsSync(p)) return { path: p, exists: false, size: 0, mtime: 0, md5: '' };
            const st = fs.statSync(p);
            let md5 = '';
            try { md5 = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch {}
            return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, md5 };
        };
        const pig = fileInfo('pig_channels.py');
        const tvc = fileInfo('config/tv_channels.json');
        // dynamic file path discovery (may live in /tmp or config/)
        let dynPath = '';
        let dynStats: any = { path: '', exists: false, size: 0, mtime: 0, md5: '', pdStreams: 0 };
        try {
            dynPath = getDynamicFilePath();
            if (dynPath && fs.existsSync(dynPath)) {
                const st = fs.statSync(dynPath);
                let md5 = '';
                try { md5 = crypto.createHash('md5').update(fs.readFileSync(dynPath)).digest('hex'); } catch {}
                // Quick scan for label occurrences (keep light: don't parse JSON if huge)
                let pdStreams = 0;
                try {
                    const raw = fs.readFileSync(dynPath, 'utf-8');
                    // Count occurrences of string "[P🐽D]" (label start) to confirm injection; fallback to "[P" if pig emoji missing fonts
                    const re = /\[P🐽D\]/g; // literal match
                    const reAlt = /\[P.D\]/g; // extremely defensive (unlikely)
                    const matches = raw.match(re);
                    pdStreams = matches ? matches.length : 0;
                    if (!pdStreams) {
                        const alt = raw.match(reAlt);
                        if (alt) pdStreams = alt.length;
                    }
                } catch {}
                dynStats = { path: dynPath, exists: true, size: st.size, mtime: st.mtimeMs, md5, pdStreams };
            } else {
                dynStats = { path: dynPath || '(empty)', exists: false, size: 0, mtime: 0, md5: '', pdStreams: 0 };
            }
        } catch (e) {
            dynStats = { path: dynPath || '(error)', exists: false, size: 0, mtime: 0, md5: '', err: String(e), pdStreams: 0 };
        }
        const fmtTime = (ms: number) => {
            if (!ms) return 0;
            try { return new Date(ms).toISOString(); } catch { return ms; }
        };
        console.log('[P🐽D][DIAG] pig_channels.py', { exists: pig.exists, size: pig.size, mtime: fmtTime(pig.mtime), md5: pig.md5.slice(0,12) });
        console.log('[P🐽D][DIAG] tv_channels.json', { exists: tvc.exists, size: tvc.size, mtime: fmtTime(tvc.mtime), md5: tvc.md5.slice(0,12) });
        console.log('[P🐽D][DIAG] dynamic_channels.json', { path: dynStats.path, exists: dynStats.exists, size: dynStats.size, mtime: fmtTime(dynStats.mtime), md5: (dynStats.md5||'').slice(0,12), pdLabelCount: dynStats.pdStreams });
        if (!dynStats.exists) {
            console.warn('[P🐽D][DIAG] dynamic_channels.json NON TROVATO al bootstrap – Live.py o pig_channels.py non ancora eseguiti nel container?');
        } else if (dynStats.exists && dynStats.pdStreams === 0) {
            console.warn('[P🐽D][DIAG] dynamic_channels.json presente ma CONTATORE label [P🐽D] = 0 – possibili cause: pig_channels non eseguito / label diversa / build cache vecchia.');
        }
    } catch (e) {
        try { console.error('[P🐽D][DIAG] Errore diagnostics startup:', e); } catch {}
    }
})();

// Cache per i link Vavoo
interface VavooCache {
    timestamp: number;
    links: Map<string, string | string[]>;
    updating: boolean;
}

const vavooCache: VavooCache = {
    timestamp: 0,
    links: new Map<string, string | string[]>(),
    updating: false
};

// Path del file di cache per Vavoo
const vavaoCachePath = path.join(__dirname, '../cache/vavoo_cache.json');

// Se la cache non esiste, genera automaticamente
if (!fs.existsSync(vavaoCachePath)) {
    console.warn('⚠️ [VAVOO] Cache non trovata, provo a generarla automaticamente...');
    try {
        const { execSync } = require('child_process');
        execSync('python3 vavoo_resolver.py --build-cache', { cwd: path.join(__dirname, '..') });
        console.log('✅ [VAVOO] Cache generata automaticamente!');
    } catch (err) {
        console.error('❌ [VAVOO] Errore nella generazione automatica della cache:', err);
    }
}

// Funzione per caricare la cache Vavoo dal file
function loadVavooCache(): void {
    try {
        if (fs.existsSync(vavaoCachePath)) {
            const rawCache = fs.readFileSync(vavaoCachePath, 'utf-8');
            // RIMOSSO: console.log('🔧 [VAVOO] RAW vavoo_cache.json:', rawCache);
            const cacheData = JSON.parse(rawCache);
            vavooCache.timestamp = cacheData.timestamp || 0;
            vavooCache.links = new Map(Object.entries(cacheData.links || {}));
            console.log(`📺 Vavoo cache caricata con ${vavooCache.links.size} canali, aggiornata il: ${new Date(vavooCache.timestamp).toLocaleString()}`);
            console.log('🔧 [VAVOO] DEBUG - Cache caricata all\'avvio:', vavooCache.links.size, 'canali');
            console.log('🔧 [VAVOO] DEBUG - Path cache:', vavaoCachePath);
            // RIMOSSO: stampa dettagliata del contenuto della cache
        } else {
            console.log(`📺 File cache Vavoo non trovato, verrà creato al primo aggiornamento`);
        }
    } catch (error) {
        console.error('❌ Errore nel caricamento della cache Vavoo:', error);
    }
}

// Funzione per salvare la cache Vavoo su file
function saveVavooCache(): void {
    try {
        // Assicurati che la directory cache esista
        const cacheDir = path.dirname(vavaoCachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: vavooCache.timestamp,
            links: Object.fromEntries(vavooCache.links)
        };

        // Salva prima in un file temporaneo e poi rinomina per evitare file danneggiati
        const tempPath = `${vavaoCachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(cacheData, null, 2), 'utf-8');

        // Rinomina il file temporaneo nel file finale
        fs.renameSync(tempPath, vavaoCachePath);

        console.log(`📺 Vavoo cache salvata con ${vavooCache.links.size} canali, timestamp: ${new Date(vavooCache.timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('❌ Errore nel salvataggio della cache Vavoo:', error);
    }
}

// Funzione per aggiornare la cache Vavoo
async function updateVavooCache(): Promise<boolean> {
    if (vavooCache.updating) {
        console.log(`📺 Aggiornamento Vavoo già in corso, skip`);
        return false;
    }

    vavooCache.updating = true;
    console.log(`📺 Avvio aggiornamento cache Vavoo...`);
    try {
        // PATCH: Prendi TUTTI i canali da Vavoo, senza filtri su tv_channels.json
        const result = await execFilePromise('python3', [
            path.join(__dirname, '../vavoo_resolver.py'),
            '--dump-channels'
        ], { timeout: 30000 });

        if (result.stdout) {
            try {
                const channels = JSON.parse(result.stdout);
                console.log(`📺 Recuperati ${channels.length} canali da Vavoo (nessun filtro)`);
                const updatedLinks = new Map<string, string>();
                for (const ch of channels) {
                    if (!ch || !ch.name || !ch.links) continue;
                    const first = Array.isArray(ch.links) ? ch.links[0] : ch.links;
                    if (first) updatedLinks.set(String(ch.name), String(first));
                }
                vavooCache.links = updatedLinks;
                vavooCache.timestamp = Date.now();
                saveVavooCache();
                console.log(`📺 Vavoo cache aggiornata: ${vavooCache.links.size} canali salvati`);
            } catch (e) {
                console.error('❌ Errore nel parsing canali Vavoo:', e);
            }
        } else {
            console.warn('⚠️ Nessun output da vavoo_resolver.py --dump-channels');
        }
        return true;
    } catch (error) {
        console.error('❌ Errore aggiornamento cache Vavoo:', error);
        return false;
    } finally {
        vavooCache.updating = false;
    }
}

const vavooAliasIndex = new Map<string, string>();

function normAlias(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // rimuovi diacritici
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildVavooAliasIndex(): void {
    try {
        vavooAliasIndex.clear();
        const source = Array.isArray(staticBaseChannels) && staticBaseChannels.length ? staticBaseChannels : tvChannels;
        for (const ch of (source as any[])) {
            if (!ch) continue;
            const aliases: string[] = Array.isArray(ch.vavooNames) && ch.vavooNames.length ? ch.vavooNames : (ch.name ? [ch.name] : []);
            for (const a of aliases) {
                const key = normAlias(String(a));
                if (!key) continue;
                if (!vavooAliasIndex.has(key)) vavooAliasIndex.set(key, String(a));
            }
        }
        console.log(`🧭 Vavoo alias index built: ${vavooAliasIndex.size} aliases`);
    } catch (e) {
        console.error('❌ Errore build Vavoo alias index:', e);
    }
}

function findBestAliasInTexts(texts: string[]): string | null {
    if (!texts || !texts.length || vavooAliasIndex.size === 0) return null;
    let best: { alias: string; len: number } | null = null;
    for (const raw of texts) {
        if (!raw) continue;
        const t = normAlias(String(raw));
        if (!t) continue;
        for (const [k, original] of vavooAliasIndex.entries()) {
            if (!k) continue;
            // match come parola intera o sottostringa significativa
            // costruisci regex che richiede confini di parola debole
            const pattern = new RegExp(`(?:^| )${k}(?: |$)`);
            if (pattern.test(t)) {
                const L = k.length;
                if (!best || L > best.len) best = { alias: original, len: L };
            }
        }
    }
    return best ? best.alias : null;
}

function resolveFirstVavooUrlForAlias(alias: string): string | null {
    if (!alias || !vavooCache || !vavooCache.links) return null;
    // 1) Prova varianti "Nome .<lettera>"
    try {
        const variantRegex = new RegExp(`^${alias} \\.([a-zA-Z])$`, 'i');
        for (const [key, value] of vavooCache.links.entries()) {
            if (variantRegex.test(key)) {
                const links = Array.isArray(value) ? value : [value];
                if (links.length) return String(links[0]);
            }
        }
        // 2) Prova match normalizzato sulle chiavi
        const aliasNorm = alias.toUpperCase().replace(/\s+/g, ' ').trim();
        for (const [key, value] of vavooCache.links.entries()) {
            const keyNorm = key.toUpperCase().replace(/\s+/g, ' ').trim();
            const rx = new RegExp(`^${aliasNorm} \\.([a-zA-Z])$`, 'i');
            if (rx.test(keyNorm)) {
                const links = Array.isArray(value) ? value : [value];
                if (links.length) return String(links[0]);
            }
        }
        // 3) Fallback chiave esatta
        const exact = vavooCache.links.get(alias) as any;
        if (exact) {
            const links = Array.isArray(exact) ? exact : [exact];
            if (links.length) return String(links[0]);
        }
    } catch (e) {
        console.error('[VAVOO] resolveFirstVavooUrlForAlias error:', e);
    }
    return null;
}

try {
    // Assicurati che le directory di cache esistano
    ensureCacheDirectories();

    staticBaseChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
    tvChannels = [...staticBaseChannels];
    domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
    epgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/epg_config.json'), 'utf-8'));

    console.log(`✅ Loaded ${tvChannels.length} TV channels`);

    // ============ TVTAP INTEGRATION ============

    // Cache per i link TVTap
    interface TVTapCache {
        timestamp: number;
        channels: Map<string, string>;
        updating: boolean;
    }

    const tvtapCache: TVTapCache = {
        timestamp: 0,
        channels: new Map<string, string>(),
        updating: false
    };

    // Path del file di cache per TVTap
    const tvtapCachePath = path.join(__dirname, '../cache/tvtap_cache.json');

    // Funzione per caricare la cache TVTap dal file
    function loadTVTapCache(): void {
        try {
            if (fs.existsSync(tvtapCachePath)) {
                const rawCache = fs.readFileSync(tvtapCachePath, 'utf-8');
                const cacheData = JSON.parse(rawCache);
                tvtapCache.timestamp = cacheData.timestamp || 0;
                tvtapCache.channels = new Map(Object.entries(cacheData.channels || {}));
                console.log(`📺 TVTap cache caricata con ${tvtapCache.channels.size} canali, aggiornata il: ${new Date(tvtapCache.timestamp).toLocaleString()}`);
            } else {
                console.log("📺 File cache TVTap non trovato, verrà creato al primo aggiornamento");
            }
        } catch (error) {
            console.error("❌ Errore nel caricamento cache TVTap:", error);
            tvtapCache.timestamp = 0;
            tvtapCache.channels = new Map();
        }
    }

    // Funzione per aggiornare la cache TVTap
    async function updateTVTapCache(): Promise<boolean> {
        if (tvtapCache.updating) {
            console.log('🔄 TVTap cache già in aggiornamento, salto...');
            return false;
        }

        tvtapCache.updating = true;
        console.log('🔄 Aggiornamento cache TVTap...');

        try {
            const options = {
                timeout: 30000,
                env: {
                    ...process.env,
                    PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                }
            };

            const { stdout, stderr } = await execFilePromise('python3', [path.join(__dirname, '../tvtap_resolver.py'), '--build-cache'], options);

            if (stderr) {
                console.error(`[TVTap] Script stderr:`, stderr);
            }

            console.log('✅ Cache TVTap aggiornata con successo');

            // Ricarica la cache aggiornata
            loadTVTapCache();

            return true;
        } catch (error: any) {
            console.error('❌ Errore durante aggiornamento cache TVTap:', error.message || error);
            return false;
        } finally {
            tvtapCache.updating = false;
        }
    }

    // ============ END TVTAP INTEGRATION ============

    // ✅ INIZIALIZZA IL ROUTER GLOBALE SUBITO DOPO IL CARICAMENTO
    console.log('🔧 Initializing global router after loading TV channels...');
    globalBuilder = createBuilder(configCache);
    globalAddonInterface = globalBuilder.getInterface();
    globalRouter = getRouter(globalAddonInterface);
    console.log('✅ Global router initialized successfully');

    // Carica la cache Vavoo
    loadVavooCache();
    // Costruisci indice alias Vavoo
    buildVavooAliasIndex();

    // Dopo il caricamento della cache Vavoo
    if (vavooCache && vavooCache.links) {
        try {
            console.log(`[VAVOO] Cache caricata: ${vavooCache.links.size} canali`);
        } catch (e) {
            console.log('[VAVOO] ERRORE DUMP CACHE:', e);
        }
    }

    // Carica la cache TVTap
    loadTVTapCache();

    // Aggiorna la cache Vavoo in background all'avvio
    setTimeout(() => {
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata con successo all'avvio`);
                // Avvia Live.py subito dopo il successo della cache Vavoo (una volta, non bloccante)
                try {
                    const livePath = path.join(__dirname, '../Live.py');
                    const fs = require('fs');
                    if (fs.existsSync(livePath)) {
                        try {
                            const st = fs.statSync(livePath);
                            console.log('[Live.py][DIAG] path=', livePath, 'size=', st.size, 'mtime=', new Date(st.mtimeMs || st.mtime).toISOString());
                        } catch {}
                        // individua interpreti python disponibili
                        const candidateBins = [process.env.PYTHON_BIN, 'python3', 'python', 'py'].filter(Boolean) as string[];
                        let chosen: string | null = null;
                        for (const b of candidateBins) {
                            try {
                                const { spawnSync } = require('child_process');
                                const r = spawnSync(b, ['-V'], { timeout: 4000 });
                                if (r.status === 0 && String(r.stdout || r.stderr).toLowerCase().includes('python')) {
                                    chosen = b; console.log('[Live.py][DIAG] interpreter ok ->', b, 'version:', (r.stdout || r.stderr).toString().trim());
                                    break;
                                }
                            } catch {}
                        }
                        if (!chosen) {
                            console.warn('[Live.py][DIAG] nessun interprete Python funzionante trovato tra', candidateBins.join(','));
                        }
                        const trySpawn = (py: string) => {
                            try {
                                const child = require('child_process').spawn(py, [livePath], { detached: true, stdio: 'ignore' });
                                child.unref();
                                console.log(`[Live.py] avviato in background con '${py}'`);
                                return true;
                            } catch { return false; }
                        };
                        if (chosen) {
                            if (!trySpawn(chosen)) console.warn('[Live.py][DIAG] spawn fallita con', chosen);
                        } else {
                            if (!trySpawn('python3')) trySpawn('python');
                        }
                    } else {
                        console.log('[Live.py] non trovato, skip');
                    }
                } catch (e) {
                    console.log('[Live.py] errore avvio non bloccante:', (e as any)?.message || e);
                }
            } else {
                console.log(`⚠️ Aggiornamento cache Vavoo fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache Vavoo all'avvio:`, error);
        });
    }, 2000);

    // Aggiorna la cache TVTap in background all'avvio
    setTimeout(() => {
        updateTVTapCache().then(success => {
            if (success) {
                console.log(`✅ Cache TVTap aggiornata con successo all'avvio`);
            } else {
                console.log(`⚠️ Aggiornamento cache TVTap fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache TVTap all'avvio:`, error);
        });
    }, 4000); // Aspetta un po' di più per non sovraccaricare

    // Programma aggiornamenti periodici della cache Vavoo (ogni 12 ore)
    const VAVOO_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache Vavoo avviato...`);
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache Vavoo fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache Vavoo:`, error);
        });
    }, VAVOO_UPDATE_INTERVAL);

    // Programma aggiornamenti periodici della cache TVTap (ogni 12 ore, offset di 1 ora)
    const TVTAP_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache TVTap avviato...`);
        updateTVTapCache().then(success => {
            if (success) {
                console.log(`✅ Cache TVTap aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache TVTap fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache TVTap:`, error);
        });
    }, TVTAP_UPDATE_INTERVAL);

    // Inizializza EPG Manager
    if (epgConfig.enabled) {
        epgManager = new EPGManager(epgConfig);
        console.log(`📺 EPG Manager inizializzato con URL: ${epgConfig.epgUrl}`);

        // Avvia aggiornamento EPG in background senza bloccare l'avvio
        setTimeout(() => {
            if (epgManager) {
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato con successo in background`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG fallito in background, verrà ritentato al prossimo utilizzo`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG in background:`, error);
                });
            }
        }, 1000);

        // Programma aggiornamenti periodici dell'EPG (ogni 6 ore)
        setInterval(() => {
            if (epgManager) {
                console.log(`🔄 Aggiornamento EPG periodico avviato...`);
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato periodicamente con successo`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG periodico fallito`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG periodico:`, error);
                });
            }
        }, epgConfig.updateInterval);
    }
} catch (error) {
    console.error('❌ Errore nel caricamento dei file di configurazione TV:', error);
}

// Funzione per determinare le categorie di un canale

function normalizeProxyUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(initialConfig: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    // Applica un filtro leggero al manifest per nascondere il catalogo TV quando disabilitato
    const effectiveManifest: Manifest = (() => {
        try {
            if (initialConfig && (initialConfig as any).disableLiveTv) {
                const filtered = { ...manifest } as Manifest;
                const cats = Array.isArray(filtered.catalogs) ? filtered.catalogs.slice() : [];
                filtered.catalogs = cats.filter(c => !(c && (c as any).id === 'streamvix_tv'));
                return filtered;
            }
        } catch {}
        return manifest;
    })();

    if (initialConfig.mediaFlowProxyUrl || initialConfig.enableMpd || initialConfig.tmdbApiKey) {
        effectiveManifest.name; // no-op to avoid unused warning pattern
    }

    const builder = new addonBuilder(effectiveManifest);

    // === TV CATALOG HANDLER ONLY ===
    builder.defineCatalogHandler(async ({ type, id, extra }: { type: string; id: string; extra?: any }) => {
        if (type === "tv") {
            // Simple runtime toggle: hide TV when disabled
            try {
                const cfg = { ...configCache } as AddonConfig;
                if (cfg.disableLiveTv) {
                    console.log('📴 TV catalog disabled by config.disableLiveTv');
                    return { metas: [], cacheMaxAge: 0 };
                }
            } catch {}
            try {
                const lastReq0: any = (global as any).lastExpressRequest;
                console.log('📥 Catalog TV request:', {
                    id,
                    extra,
                    path: lastReq0?.path,
                    url: lastReq0?.url
                });
            } catch {}
            // === Catalogo TV: modalità NO CACHE per test (di default attiva) ===
            const disableCatalogCache = (() => {
                try {
                    const v = (process?.env?.NO_TV_CATALOG_CACHE ?? '1').toString().toLowerCase();
                    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
                } catch { return true; }
            })();

            if (disableCatalogCache) {
                try {
                    // Ricarica sempre dal JSON dinamico e rifai il merge ad ogni richiesta
                    loadDynamicChannels(true);
                    tvChannels = mergeDynamic([...staticBaseChannels]);
                    debugLog(`⚡ Catalog rebuilt (NO_CACHE) count=${tvChannels.length}`);
                } catch (e) {
                    console.error('❌ Merge dynamic channels failed (NO_CACHE):', e);
                }
            } else {
                // Fallback: usa cache leggera in memoria
                const staticSig = staticBaseChannels.length;
                const cacheKey = `${staticSig}`;
                const g: any = global as any;
                if (!g.__tvCatalogCache) g.__tvCatalogCache = { key: '', channels: [] };
                if (g.__tvCatalogCache.key !== cacheKey) {
                    try {
                        loadDynamicChannels(false);
                        tvChannels = mergeDynamic([...staticBaseChannels]);
                        g.__tvCatalogCache = { key: cacheKey, channels: tvChannels };
                        debugLog(`⚡ Catalog rebuild (cache miss) newKey=${cacheKey} count=${tvChannels.length}`);
                    } catch (e) {
                        console.error('❌ Merge dynamic channels failed:', e);
                    }
                } else {
                    tvChannels = g.__tvCatalogCache.channels;
                    debugLog(`⚡ Catalog served from cache key=${cacheKey} count=${tvChannels.length}`);
                }
            }
            let filteredChannels = tvChannels;
            let requestedSlug: string | null = null;
            let isPlaceholder = false;

            // === SEARCH HANDLER ===
            if (extra && typeof extra.search === 'string' && extra.search.trim().length > 0) {
                const rawQ = extra.search.trim();
                const tokens = rawQ.toLowerCase().split(/\s+/).filter(Boolean);
                console.log(`🔎 Search (OR+fuzzy) query tokens:`, tokens);
                const seen = new Set<string>();

                const simpleLevenshtein = (a: string, b: string): number => {
                    if (a === b) return 0;
                    const al = a.length, bl = b.length;
                    if (Math.abs(al - bl) > 1) return 99; // prune (we only care distance 0/1)
                    const dp: number[] = Array(bl + 1).fill(0);
                    for (let j = 0; j <= bl; j++) dp[j] = j;
                    for (let i = 1; i <= al; i++) {
                        let prev = dp[0];
                        dp[0] = i;
                        for (let j = 1; j <= bl; j++) {
                            const tmp = dp[j];
                            if (a[i - 1] === b[j - 1]) dp[j] = prev; else dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
                            prev = tmp;
                        }
                    }
                    return dp[bl];
                };

                const tokenMatches = (token: string, hay: string, words: string[]): boolean => {
                    if (!token) return false;
                    if (hay.includes(token)) return true; // substring
                    // prefix match on any word
                    if (words.some(w => w.startsWith(token))) return true;
                    // fuzzy distance 1 on words (only if token length > 3 to avoid noise)
                    if (token.length > 3) {
                        for (const w of words) {
                            if (Math.abs(w.length - token.length) > 1) continue;
                            if (simpleLevenshtein(token, w) <= 1) return true;
                        }
                    }
                    return false;
                };

                filteredChannels = tvChannels.filter((c: any) => {
                    const categories = getChannelCategories(c); // include category slugs
                    const categoryStr = categories.join(' ');
                    const hayRaw = `${c.name || ''} ${(c.description || '')} ${categoryStr}`.toLowerCase();
                    const words = hayRaw.split(/[^a-z0-9]+/).filter(Boolean);
                    const ok = tokens.some((t: string) => tokenMatches(t, hayRaw, words)); // OR logic
                    if (ok) {
                        if (seen.has(c.id)) return false;
                        seen.add(c.id);
                        return true;
                    }
                    return false;
                }).slice(0, 200);
                console.log(`🔎 Search results (OR+fuzzy): ${filteredChannels.length}`);
            } else {
                // === GENRE FILTERING (robusto) ===
                let genreInput: string | undefined;
                // extra come stringa: "genre=coppe&x=y"
                if (typeof extra === 'string') {
                    const parts = extra.split('&');
                    for (const p of parts) {
                        const [k,v] = p.split('=');
                        if (k === 'genre' && v) genreInput = decodeURIComponent(v);
                    }
                }
                // extra oggetto
                if (!genreInput && extra && typeof extra === 'object' && extra.genre) genreInput = String(extra.genre);
                // fallback ultima richiesta express
                const lastReq: any = (global as any).lastExpressRequest;
                if (!genreInput && lastReq?.query) {
                    if (typeof lastReq.query.genre === 'string') genreInput = lastReq.query.genre;
                    else if (typeof lastReq.query.extra === 'string') {
                        const m = lastReq.query.extra.match(/genre=([^&]+)/i); if (m) genreInput = decodeURIComponent(m[1]);
                    } else if (lastReq.query.extra && typeof lastReq.query.extra === 'object' && lastReq.query.extra.genre) {
                        genreInput = String(lastReq.query.extra.genre);
                    }
                }
                // Fallback: prova ad estrarre genre anche dal path/URL se non presente
                if (!genreInput) {
                    try {
                        const lastReq2: any = (global as any).lastExpressRequest;
                        const fromUrl = (lastReq2?.url || '') as string;
                        const fromPath = (lastReq2?.path || '') as string;
                        let extracted: string | undefined;
                        // 1) Query string
                        const qMatch = fromUrl.match(/genre=([^&]+)/i);
                        if (qMatch) extracted = decodeURIComponent(qMatch[1]);
                        // 2) Extra nel path: /catalog/tv/tv-channels/genre=Coppe.json oppure .../genre=Coppe&...
            if (!extracted) {
                            const pMatch = fromPath.match(/\/catalog\/[^/]+\/[^/]+\/([^?]+)\.json/i);
                            if (pMatch && pMatch[1]) {
                                const extraSeg = decodeURIComponent(pMatch[1]);
                                const g2 = extraSeg.match(/(?:^|&)genre=([^&]+)/i);
                                if (g2) extracted = g2[1];
                else if (extraSeg.startsWith('genre=')) extracted = extraSeg.split('=')[1];
                else if (extraSeg && !extraSeg.includes('=')) extracted = extraSeg; // support /.../Coppe.json
                            }
                        }
                        if (extracted) {
                            genreInput = extracted;
                            console.log(`🔎 Fallback genre extracted from URL/path: '${genreInput}'`);
                        }
                    } catch {}
                }

                if (genreInput) {
                    // Normalizza spazi invisibili e accenti
                    genreInput = genreInput.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
                    const norm = genreInput.trim().toLowerCase()
                        .replace(/[àáâãä]/g,'a').replace(/[èéêë]/g,'e')
                        .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o')
                        .replace(/[ùúûü]/g,'u');
                    const genreMap: { [key: string]: string } = {
                        'rai':'rai','mediaset':'mediaset','sky':'sky','bambini':'kids','news':'news','sport':'sport','cinema':'movies','generali':'general','documentari':'documentari','discovery':'discovery','pluto':'pluto','serie a':'seriea','serie b':'serieb','serie c':'seriec','coppe':'coppe','soccer':'soccer','tennis':'tennis','f1':'f1','motogp':'motogp','basket':'basket','volleyball':'volleyball','ice hockey':'icehockey','wrestling':'wrestling','boxing':'boxing','darts':'darts','baseball':'baseball','nfl':'nfl'
                    };
                    // Aggiungi mapping per nuove leghe
                    genreMap['premier league'] = 'premierleague';
                    genreMap['liga'] = 'liga';
                    genreMap['bundesliga'] = 'bundesliga';
                    genreMap['ligue 1'] = 'ligue1';
                    const target = genreMap[norm] || norm;
                    requestedSlug = target;
                    filteredChannels = tvChannels.filter(ch => getChannelCategories(ch).includes(target));
                    console.log(`🔍 Genre='${norm}' -> slug='${target}' results=${filteredChannels.length}`);
                } else {
                    console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
                }
            }

            // Se filtro richiesto e nessun canale trovato -> aggiungi placeholder
            if (requestedSlug && filteredChannels.length === 0) {
                const PLACEHOLDER_ID = `placeholder-${requestedSlug}`;
                const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                filteredChannels = [{
                    id: PLACEHOLDER_ID,
                    name: 'Nessuno Stream disponibile oggi',
                    logo: placeholderLogo,
                    poster: placeholderLogo,
                    type: 'tv',
                    category: [requestedSlug],
                    genres: [requestedSlug],
                    description: 'Nessuno Stream disponibile oggi. Live 🔴',
                    _placeholder: true,
                    placeholderVideo: `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`
                }];
                isPlaceholder = true;
            }

            // Ordina SOLO gli eventi dinamici per eventStart (asc) quando è presente un filtro di categoria
            try {
                if (requestedSlug && filteredChannels.length) {
                    const dynWithIndex = filteredChannels
                        .map((ch: any, idx: number) => ({ ch, idx }))
                        .filter(x => !!x.ch && (x.ch as any)._dynamic);
                    const compare = (a: any, b: any) => {
                        const aS = a?.eventStart || a?.eventstart;
                        const bS = b?.eventStart || b?.eventstart;
                        const ap = aS ? Date.parse(aS) : NaN;
                        const bp = bS ? Date.parse(bS) : NaN;
                        const aHas = !isNaN(ap);
                        const bHas = !isNaN(bp);
                        if (aHas && bHas) return ap - bp;
                        if (aHas && !bHas) return -1;
                        if (!aHas && bHas) return 1;
                        return (a?.name || '').localeCompare(b?.name || '');
                    };
                    dynWithIndex.sort((A, B) => compare(A.ch, B.ch));
                    const sortedDyn = dynWithIndex.map(x => x.ch);
                    let di = 0;
                    filteredChannels = filteredChannels.map((ch: any) => ch && (ch as any)._dynamic ? sortedDyn[di++] : ch);
                    console.log(`⏱️ Sorted only dynamic events within category '${requestedSlug}' (asc)`);
                }
            } catch {}

            // Aggiungi prefisso tv: agli ID, posterShape landscape e EPG
                const tvChannelsWithPrefix = await Promise.all(filteredChannels.map(async (channel: any) => {
                const channelWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || ''
                };

                // Per canali dinamici: niente EPG, mostra solo ora inizio evento
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart; // fallback
                    const stripTimePrefix = (t: string): string => t.replace(/^\s*([⏰🕒]?\s*)?\d{1,2}[\.:]\d{2}\s*[:\-]\s*/i, '').trim();
                    if (eventStart) {
                        try {
                            const hhmm = epgManager ? epgManager.formatDynamicHHMM(eventStart) : new Date(eventStart).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, ':');
                            const ddmm = epgManager ? epgManager.formatDynamicDDMM(eventStart) : '';
                            const rawTitle = stripTimePrefix(channel.name || '');
                            const parts = rawTitle.split(' - ').map(s => s.trim()).filter(Boolean);
                            const eventTitle = parts[0] || rawTitle;
                            // Deriva league + date + country dal resto
                            let tail = parts.slice(1).join(' - ');
                            const dateMatch = rawTitle.match(/\b(\d{1,2}\/\d{1,2})\b/);
                            const dateStr = dateMatch?.[1] || ddmm;
                            const hasItaly = /\bitaly\b/i.test(rawTitle);
                            // Rimuovi date/country dal tail per ottenere la lega pulita
                            let league = tail
                                .replace(/\b(\d{1,2}\/\d{1,2})\b/gi, '')
                                .replace(/\bitaly\b/gi, '')
                                .replace(/\s{2,}/g, ' ')
                                .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
                                .trim();
                            // Titolo canale: Evento ⏰ HH:MM - DD/MM (senza Italy, senza lega)
                            (channelWithPrefix as any).name = `${eventTitle} ⏰ ${hhmm}${dateStr ? ` - ${dateStr}` : ''}`;
                            // Summary: 🔴 Inizio: HH:MM - Evento - Lega - DD/MM Italy
                            channelWithPrefix.description = `🔴 Inizio: ${hhmm} - ${eventTitle}${league ? ` - ${league}` : ''}${dateStr ? ` - ${dateStr}` : ''}${hasItaly ? ' Italy' : ''}`.trim();
                        } catch {
                            channelWithPrefix.description = channel.name || '';
                        }
                    } else {
                        // Se manca l'orario, mantieni nome e descrizione originali
                        channelWithPrefix.description = channel.name || '';
                    }
                } else if (epgManager) {
                    // Canali tradizionali: EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start, 'live');
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop, 'live') : '';
                                const epgInfo = `🔴 ORA: ${currentProgram.title} (${startTime}${endTime ? `-${endTime}` : ''})`;
                                channelWithPrefix.description = `${channel.description || ''}\n\n${epgInfo}`;
                            }
                        }
                    } catch (epgError) {
                        console.error(`❌ Catalog: EPG error for ${channel.name}:`, epgError);
                    }
                }

                return channelWithPrefix;
            }));

                console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id}${isPlaceholder ? ' (placeholder, cacheMaxAge=0)' : ''}`);
                return isPlaceholder
                    ? { metas: tvChannelsWithPrefix, cacheMaxAge: 0 }
                    : { metas: tvChannelsWithPrefix };
        }
        console.log(`❌ No catalog found for type=${type}, id=${id}`);
        return { metas: [] };
    });

    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
        console.log(`📺 META REQUEST: type=${type}, id=${id}`);
        if (type === "tv") {
            try {
                const cfg = { ...configCache } as AddonConfig;
                if (cfg.disableLiveTv) {
                    console.log('📴 TV meta disabled by config.disableLiveTv');
                    return { meta: null };
                }
            } catch {}
            // Gestisci tutti i possibili formati di ID che Stremio può inviare
            let cleanId = id;
            if (id.startsWith('tv:')) {
                cleanId = id.replace('tv:', '');
            } else if (id.startsWith('tv%3A')) {
                cleanId = id.replace('tv%3A', '');
            } else if (id.includes('%3A')) {
                // Decodifica URL-encoded (:)
                cleanId = decodeURIComponent(id);
                if (cleanId.startsWith('tv:')) {
                    cleanId = cleanId.replace('tv:', '');
                }
            }

            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel for meta: ${channel.name}`);

                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || '',
                    genre: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    genres: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    year: new Date().getFullYear().toString(),
                    imdbRating: null,
                    releaseInfo: "Live TV",
                    country: "IT",
                    language: "it"
                };

                // Meta: canali dinamici senza EPG con ora inizio
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart;
                    let finalDesc = channel.name || '';
                    const stripTimePrefix = (t: string): string => t.replace(/^\s*([⏰🕒]?\s*)?\d{1,2}[\.:]\d{2}\s*[:\-]\s*/i, '').trim();
                    if (eventStart) {
                        try {
                            const hhmm = epgManager ? epgManager.formatDynamicHHMM(eventStart) : new Date(eventStart).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, ':');
                            const ddmm = epgManager ? epgManager.formatDynamicDDMM(eventStart) : '';
                            const rawTitle = stripTimePrefix(channel.name || '');
                            const parts = rawTitle.split(' - ').map(s => s.trim()).filter(Boolean);
                            const eventTitle = parts[0] || rawTitle;
                            let tail = parts.slice(1).join(' - ');
                            const dateMatch = rawTitle.match(/\b(\d{1,2}\/\d{1,2})\b/);
                            const dateStr = dateMatch?.[1] || ddmm;
                            const hasItaly = /\bitaly\b/i.test(rawTitle);
                            let league = tail
                                .replace(/\b(\d{1,2}\/\d{1,2})\b/gi, '')
                                .replace(/\bitaly\b/gi, '')
                                .replace(/\s{2,}/g, ' ')
                                .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
                                .trim();
                            // Nome coerente anche nel meta: Evento ⏰ HH:MM - DD/MM
                            (metaWithPrefix as any).name = `${eventTitle} ⏰ ${hhmm}${dateStr ? ` - ${dateStr}` : ''}`;
                            finalDesc = `🔴 Inizio: ${hhmm} - ${eventTitle}${league ? ` - ${league}` : ''}${dateStr ? ` - ${dateStr}` : ''}${hasItaly ? ' Italy' : ''}`.trim();
                        } catch {/* ignore */}
                    }
                    (metaWithPrefix as any).description = finalDesc;
                } else if (epgManager) {
                    // Meta: canali tradizionali con EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            const nextProgram = await epgManager.getNextProgram(epgChannelId);
                            let epgDescription = channel.description || '';
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start, 'live');
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop, 'live') : '';
                                epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                                if (currentProgram.description) epgDescription += `\n${currentProgram.description}`;
                            }
                            if (nextProgram) {
                                const nextStartTime = epgManager.formatTime(nextProgram.start, 'live');
                                const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop, 'live') : '';
                                epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                                if (nextProgram.description) epgDescription += `\n${nextProgram.description}`;
                            }
                            metaWithPrefix.description = epgDescription;
                        }
                    } catch (epgError) {
                        console.error(`❌ Meta: EPG error for ${channel.name}:`, epgError);
                    }
                }

                return { meta: metaWithPrefix };
            } else {
                // Fallback per placeholder non persistiti in tvChannels
                if (cleanId.startsWith('placeholder-')) {
                    const slug = cleanId.replace('placeholder-', '') || 'general';
                    const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                    const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                    const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                    const name = 'Nessuno Stream disponibile oggi';
                    const meta = {
                        id: `tv:${cleanId}`,
                        type: 'tv',
                        name,
                        posterShape: 'landscape',
                        poster: placeholderLogo,
                        logo: placeholderLogo,
                        background: placeholderLogo,
                        description: 'Nessuno Stream disponibile oggi. Live 🔴',
                        genre: [slug],
                        genres: [slug],
                        year: new Date().getFullYear().toString(),
                        imdbRating: null,
                        releaseInfo: 'Live TV',
                        country: 'IT',
                        language: 'it',
                        _placeholder: true,
                        placeholderVideo
                    } as any;
                    console.log(`🧩 Generated dynamic placeholder meta for missing channel ${cleanId}`);
                    return { meta };
                }
                console.log(`❌ No meta found for channel ID: ${id}`);
                return { meta: null };
            }
        }

        // Meta handler per film/serie (logica originale)
        return { meta: null };
    });

    // === HANDLER STREAM ===
    builder.defineStreamHandler(
        async ({
            id,
            type,
        }: {
            id: string;
            type: string;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);

                // ✅ USA SEMPRE la configurazione dalla cache globale più aggiornata
                const config = { ...configCache };
                console.log(`🔧 Using global config cache for stream:`, config);

                const allStreams: Stream[] = [];

                // Prima della logica degli stream TV, aggiungi:
                // Usa sempre lo stesso proxy per tutto
                // MediaFlow config: allow fallback to environment variables if not provided via addon config
                let mfpUrlRaw = '';
                let mfpPswRaw = '';
                try {
                    mfpUrlRaw = (config.mediaFlowProxyUrl || (process && process.env && (process.env.MFP_URL || process.env.MEDIAFLOW_PROXY_URL)) || '').toString().trim();
                    mfpPswRaw = (config.mediaFlowProxyPassword || (process && process.env && (process.env.MFP_PASSWORD || process.env.MEDIAFLOW_PROXY_PASSWORD)) || '').toString().trim();
                } catch {}
                let mfpUrl = mfpUrlRaw ? normalizeProxyUrl(mfpUrlRaw) : '';
                let mfpPsw = mfpPswRaw;
                debugLog(`[MFP] Using url=${mfpUrl ? 'SET' : 'MISSING'} pass=${mfpPsw ? 'SET' : 'MISSING'}`);

                // === LOGICA TV ===
                if (type === "tv") {
                    // Runtime disable live TV
                    try {
                        const cfg2 = { ...configCache } as AddonConfig;
                        if (cfg2.disableLiveTv) {
                            console.log('📴 TV streams disabled by config.disableLiveTv');
                            return { streams: [] };
                        }
                    } catch {}
                    // Assicura che i canali dinamici siano presenti anche se la prima richiesta è uno stream (senza passare dal catalog)
                    try {
                        loadDynamicChannels(false);
                        tvChannels = mergeDynamic([...staticBaseChannels]);
                    } catch (e) {
                        console.error('❌ Stream handler: mergeDynamic failed:', e);
                    }
                    // Improved channel ID parsing to handle different formats from Stremio
                    let cleanId = id;

                    // Gestisci tutti i possibili formati di ID che Stremio può inviare
                    if (id.startsWith('tv:')) {
                        cleanId = id.replace('tv:', '');
                    } else if (id.startsWith('tv%3A')) {
                        cleanId = id.replace('tv%3A', '');
                    } else if (id.includes('%3A')) {
                        // Decodifica URL-encoded (:)
                        cleanId = decodeURIComponent(id);
                        if (cleanId.startsWith('tv:')) {
                            cleanId = cleanId.replace('tv:', '');
                        }
                    }

                    debugLog(`Looking for channel with ID: ${cleanId} (original ID: ${id})`);
                    const channel = tvChannels.find((c: any) => c.id === cleanId);

                    if (!channel) {
                        // Gestione placeholder non presente in tvChannels
                        if (cleanId.startsWith('placeholder-')) {
                            const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                            const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                            console.log(`🧩 Placeholder channel requested (ephemeral): ${cleanId}`);
                            return { streams: [ { url: placeholderVideo, title: 'Nessuno Stream' } ] };
                        }
                        console.log(`❌ Channel ${id} not found`);
                        debugLog(`❌ Channel not found in the TV channels list. Original ID: ${id}, Clean ID: ${cleanId}`);
                        return { streams: [] };
                    }

                    // Gestione placeholder: ritorna un singolo "stream" fittizio (immagine)
                    if ((channel as any)._placeholder) {
                        const vid = (channel as any).placeholderVideo || (channel as any).logo || (channel as any).poster || '';
                        return { streams: [ {
                            url: vid,
                            title: 'Nessuno Stream'
                        } ] };
                    }

                    console.log(`✅ Found channel: ${channel.name}`);

                    // Debug della configurazione proxy
                    debugLog(`Config DEBUG - mediaFlowProxyUrl: ${config.mediaFlowProxyUrl}`);
                    debugLog(`Config DEBUG - mediaFlowProxyPassword: ${config.mediaFlowProxyPassword ? '***' : 'NOT SET'}`);

                    let streams: { url: string; title: string }[] = [];
                    const vavooCleanPromises: Promise<void>[] = [];
                    // Collect clean Vavoo results per variant index to prepend in order later
                    const vavooCleanPrepend: Array<{ url: string; title: string } | undefined> = [];
                    // Keep track of found Vavoo variant URLs to allow fallback insertion
                    const vavooFoundUrls: string[] = [];
                    // Stato toggle MPD (solo da config checkbox, niente override da env per evitare comportamento inatteso)
                    const mpdEnabled = !!config.enableMpd;

                    // Dynamic event channels: dynamicDUrls -> usa stessa logica avanzata di staticUrlD per estrarre link finale
                    if ((channel as any)._dynamic) {
                        const dArr = Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [];
                        console.log(`[DynamicStreams] Channel ${channel.id} dynamicDUrls count=${dArr.length}`);
                        if (dArr.length === 0) {
                            console.log(`[DynamicStreams] ⚠️ Nessuno stream dinamico presente nel canale (dynamicDUrls vuoto)`);
                        }
                        // Click-time Vavoo injection: se trovi un canale "con la bandierina" (titolo provider), prova a mappare su Vavoo
                        try {
                            const providerTitles = dArr.map((e: any) => String(e?.title || '')).filter(Boolean);
                            // dai la priorità a titoli che contengono indicatori italiani
                            const itaPrefer = providerTitles.filter((t: string) => /\b(it|ita|italy|italia|italian|italiano|sky|dazn|eurosport|rai|now)\b/i.test(t));
                            const candidateTexts = itaPrefer.length ? itaPrefer : providerTitles;
                            const alias = findBestAliasInTexts(candidateTexts);
                            if (alias) {
                                const vUrl = resolveFirstVavooUrlForAlias(alias);
                                if (vUrl) {
                                    // Only prepend the CLEAN non-MFP link (per-request, with headers)
                                    const reqObj: any = (global as any).lastExpressRequest;
                                    const clientIp = getClientIpFromReq(reqObj);
                                    let vavooCleanResolved: { url: string; headers: Record<string,string> } | null = null;
                                    try {
                                        const clean = await resolveVavooCleanUrl(vUrl, clientIp);
                                        if (clean && clean.url) {
                                            vavooCleanResolved = clean;
                                            vdbg('Alias clean resolved', { alias, url: clean.url.substring(0, 140) });
                                            const title2 = `🏠 ${alias} (Vavoo🔓) [ITA]`;
                                            // stash headers via behaviorHints when pushing later
                                            streams.unshift({ url: clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64'), title: title2 });
                                        }
                                    } catch (ee) {
                                        const msg = (ee as any)?.message || ee;
                                        vdbg('Alias clean resolve failed', { alias, error: msg });
                                        console.log('[VAVOO] Clean resolve skipped/failed:', msg);
                                    }
                                    // Iniezione Vavoo/MFP: incapsula SEMPRE l'URL vavoo.to originale (come in Live TV), senza extractor
                                    try {
                                        if (mfpUrl && mfpPsw) {
                                            const finalUrl2 = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(vUrl)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                            const title3 = `🌐 ${alias} (Vavoo/MFP) [ITA]`;
                                            let insertAt = 0;
                                            try { if (streams.length && /(\(Vavoo\))/i.test(streams[0].title)) insertAt = 1; } catch {}
                                            try { streams.splice(insertAt, 0, { url: finalUrl2, title: title3 }); } catch { streams.push({ url: finalUrl2, title: title3 }); }
                                            vdbg('Alias Vavoo/MFP injected (direct proxy/hls on vUrl)', { alias, url: finalUrl2.substring(0, 140) });
                                        } else {
                                            vdbg('Skip Vavoo/MFP injection: MFP config missing');
                                        }
                                    } catch (e2) {
                                        vdbg('Vavoo/MFP injection error', String((e2 as any)?.message || e2));
                                    }
                                    // Iniezioni extra: DAZN ZONA IT -> usa staticUrlMpd di 'dazn1'; EUROSPORT 1/2 IT -> usa staticUrlMpd di 'eurosport1'/'eurosport2'
                                    try {
                                        const textsScan: string[] = [channel?.name || '', ...candidateTexts].map(t => (t || '').toLowerCase());
                                        const hasDaznZonaIt = textsScan.some(t => /dazn\s*zona\s*it/.test(t));
                                        const hasEu1It = textsScan.some(t => /eurosport\s*1/.test(t) && /\bit\b/.test(t));
                                        const hasEu2It = textsScan.some(t => /eurosport\s*2/.test(t) && /\bit\b/.test(t));
                                        const injectFromStaticMpd = async (staticId: string) => {
                                            try {
                                                const base = (staticBaseChannels || []).find((c: any) => c && c.id === staticId);
                                                if (!base || !base.staticUrlMpd) return;
                                                const decodedUrl = decodeStaticUrl(base.staticUrlMpd);
                                                let finalUrl = decodedUrl;
                                                let proxyUsed = false;
                                                if (mfpUrl && mfpPsw) {
                                                    const urlParts = decodedUrl.split('&');
                                                    const baseUrl = urlParts[0];
                                                    const additionalParams = urlParts.slice(1);
                                                    finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;
                                                    for (const param of additionalParams) if (param) finalUrl += `&${param}`;
                                                    proxyUsed = true;
                                                }
                                                const title = `${proxyUsed ? '' : '[❌Proxy]'}[🎬MPD] ${base.name} [ITA]`;
                                                let insertAt = 0;
                                                try { while (insertAt < streams.length && /(\(Vavoo🔓\))/i.test(streams[insertAt].title)) insertAt++; } catch {}
                                                try { streams.splice(insertAt, 0, { url: finalUrl, title }); } catch { streams.push({ url: finalUrl, title }); }
                                                vdbg('Injected staticUrlMpd from static channel', { id: staticId, url: finalUrl.substring(0, 140) });
                                            } catch {}
                                        };
                                        if (hasDaznZonaIt) await injectFromStaticMpd('dazn1');
                                        if (hasEu1It) await injectFromStaticMpd('eurosport1');
                                        if (hasEu2It) await injectFromStaticMpd('eurosport2');
                                    } catch {}
                                    console.log(`✅ [VAVOO] Injected first stream from alias='${alias}' -> ${vUrl.substring(0, 60)}...`);
                                } else {
                                    console.log(`⚠️ [VAVOO] Alias trovato ma nessun URL in cache: '${alias}'`);
                                }
                            } else {
                                console.log('[VAVOO] Nessun alias broadcaster riconosciuto nei titoli provider');
                            }
                        } catch (e) {
                            console.error('❌ [VAVOO] Errore injection dinamico:', (e as any)?.message || e);
                        }
                    }
                    let dynamicHandled = false;
                    // FAST DIRECT MODE opzionale (solo se esplicitamente richiesto via env FAST_DYNAMIC=1)
                    // FAST_DYNAMIC: se impostato a 1/true salta extractor e usa URL dirette dal JSON
                    const fastDynamic = (process.env.FAST_DYNAMIC === '1' || process.env.FAST_DYNAMIC === 'true');
                    if ((channel as any)._dynamic && Array.isArray((channel as any).dynamicDUrls) && (channel as any).dynamicDUrls.length && fastDynamic) {
                        debugLog(`[DynamicStreams] FAST branch attiva (FAST_DYNAMIC=1) canale=${channel.id}`);
                        let entries: { url: string; title?: string }[] = (channel as any).dynamicDUrls.map((e: any) => ({
                            url: e.url,
                            title: (e.title || 'Stream').replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim()
                        }));
                        const capRaw = parseInt(process.env.DYNAMIC_EXTRACTOR_CONC || '10', 10);
                        const CAP = Math.min(Math.max(1, isNaN(capRaw) ? 10 : capRaw), 50);
                        if (entries.length > CAP) {
                            const tier1Regex = /\b(it|ita|italy|italia)\b/i;
                            const tier2Regex = /\b(italian|italiano|sky|tnt|amazon|dazn|eurosport|prime|bein|canal|sportitalia|now|rai)\b/i;
                            const tier1: typeof entries = [];
                            const tier2: typeof entries = [];
                            const others: typeof entries = [];
                            for (const e of entries) {
                                const t = (e.title || '').toLowerCase();
                                if (tier1Regex.test(t)) tier1.push(e);
                                else if (tier2Regex.test(t)) tier2.push(e);
                                else others.push(e);
                            }
                            entries = [...tier1, ...tier2, ...others].slice(0, CAP);
                            debugLog(`[DynamicStreams][FAST] limit ${CAP} applied tier1=${tier1.length} tier2=${tier2.length} total=${(channel as any).dynamicDUrls.length}`);
                        }
                        for (const e of entries) {
                            if (!e || !e.url) continue;
                            let t = (e.title || 'Stream').trim();
                            if (!t) t = 'Stream';
                            t = t.replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim();
                            // Aggiungi prefisso [Player Esterno] salvo casi speciali (Strd / RB77 / SPSO / PD / dTV)
                            // Include SPSO e consente [Strd] senza spazio successivo
                            if (!/^\[(Strd|RB77|SPSO|P🐽D|🌍dTV)\b/.test(t)) t = `[Player Esterno] ${t}`;
                            streams.push({ url: e.url, title: t });
                        }
                        debugLog(`[DynamicStreams][FAST] restituiti ${streams.length} stream diretti (senza extractor) con etichetta condizionale 'Player Esterno'`);
                        dynamicHandled = true;
                    } else if ((channel as any)._dynamic && Array.isArray((channel as any).dynamicDUrls) && (channel as any).dynamicDUrls.length) {
                        debugLog(`[DynamicStreams] EXTRACTOR branch attiva (FAST_DYNAMIC disattivato) canale=${channel.id}`);
                        const startDyn = Date.now();
                        let entries: { url: string; title?: string }[] = (channel as any).dynamicDUrls.map((e: any) => ({
                            url: e.url,
                            title: (e.title || 'Stream').replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim()
                        }));
                        const maxConcRaw = parseInt(process.env.DYNAMIC_EXTRACTOR_CONC || '10', 10);
                        const CAP = Math.min(Math.max(1, isNaN(maxConcRaw) ? 10 : maxConcRaw), 50);
                        let extraFast: { url: string; title?: string }[] = [];
                        if (entries.length > CAP) {
                            // Tiered priority: tier1 strictly (it|ita|italy) first, then tier2 broader providers, then rest
                            const tier1Regex = /\b(it|ita|italy|italia)\b/i;
                            const tier2Regex = /\b(italian|italiano|sky|tnt|amazon|dazn|eurosport|prime|bein|canal|sportitalia|now|rai)\b/i;
                            const tier1: typeof entries = [];
                            const tier2: typeof entries = [];
                            const others: typeof entries = [];
                            for (const e of entries) {
                                const t = (e.title || '').toLowerCase();
                                if (tier1Regex.test(t)) tier1.push(e);
                                else if (tier2Regex.test(t)) tier2.push(e);
                                else others.push(e);
                            }
                            const ordered = [...tier1, ...tier2, ...others];
                            entries = ordered.slice(0, CAP);
                            extraFast = ordered.slice(CAP); // fallback direct for remaining
                            debugLog(`[DynamicStreams][EXTRACTOR] cap ${CAP} applied tier1=${tier1.length} tier2=${tier2.length} extraFast=${extraFast.length} total=${(channel as any).dynamicDUrls.length}`);
                        }
                        const resolved: { url: string; title: string }[] = [];
                        const itaRegex = /\b(it|ita|italy|italia|italian|italiano)$/i;
                        const CONCURRENCY = Math.min(entries.length, CAP); // Extract up to CAP in parallel (bounded by entries)
                        let index = 0;
                        const worker = async () => {
                            while (true) {
                                const i = index++;
                                if (i >= entries.length) break;
                                const d = entries[i];
                                if (!d || !d.url) continue;
                                let providerTitle = (d.title || 'Stream').trim().replace(/^\((.*)\)$/,'$1').trim();
                                if (itaRegex.test(providerTitle) && !providerTitle.startsWith('🇮🇹')) providerTitle = `🇮🇹 ${providerTitle}`;
                                try {
                                    const r = await resolveDynamicEventUrl(d.url, providerTitle, mfpUrl, mfpPsw);
                                    resolved.push(r);
                                } catch (e) {
                                    debugLog('[DynamicStreams] extractor errore singolo stream:', (e as any)?.message || e);
                                }
                            }
                        };
                        await Promise.all(Array(Math.min(CONCURRENCY, entries.length)).fill(0).map(() => worker()));
                        resolved.sort((a, b) => {
                            const itaA = a.title.startsWith('🇮🇹') ? 0 : 1;
                            const itaB = b.title.startsWith('🇮🇹') ? 0 : 1;
                            if (itaA !== itaB) return itaA - itaB;
                            return a.title.localeCompare(b.title);
                        });
                        for (const r of resolved) streams.push(r);
                        // Append leftover entries (beyond CAP) as direct FAST (no extractor) to still expose them
            if (extraFast.length) {
                            const leftoversToShow = CAP === 1 ? extraFast.slice(0, 1) : extraFast;
                            let appended = 0;
                            for (const e of leftoversToShow) {
                                if (!e || !e.url) continue;
                                let t = (e.title || 'Stream').trim();
                                if (!t) t = 'Stream';
                                t = t.replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim();
                                if (!/^\[(Strd|RB77|SPSO|P🐽D|🌍dTV)\b/.test(t)) t = `[Player Esterno] ${t}`;
                                streams.push({ url: e.url, title: t });
                                appended++;
                            }
                            debugLog(`[DynamicStreams][EXTRACTOR] appended ${appended}/${extraFast.length} leftover direct streams (CAP=${CAP}) con etichetta condizionale 'Player Esterno'`);
                        }
                        debugLog(`[DynamicStreams][EXTRACTOR] Resolved ${resolved.length}/${entries.length} streams in ${Date.now() - startDyn}ms (conc=${CONCURRENCY})`);
                        dynamicHandled = true;
                    } else if ((channel as any)._dynamic) {
                        // Dynamic channel ma senza dynamicDUrls -> placeholder stream
                        streams.push({ url: (channel as any).placeholderVideo || (channel as any).logo || (channel as any).poster || '', title: 'Nessuno Stream' });
                        dynamicHandled = true;
                    } else {
                        // staticUrlF: Direct for non-dynamic
                        // pdUrlF: nuovo flusso provider [PD] (derivato da playlist) da mostrare sempre se presente
                        if ((channel as any).pdUrlF) {
                            try {
                                const pdUrl = (channel as any).pdUrlF;
                                if (pdUrl && !streams.some(s => s.url === pdUrl)) {
                                    // Inserisci il flusso PD sempre in prima posizione
                                    streams.unshift({
                                        url: pdUrl,
                                        title: `[P🐽D] ${channel.name}`
                                    });
                                    debugLog(`Aggiunto pdUrlF Direct: ${pdUrl}`);
                                }
                            } catch (e) {
                                debugLog('Errore aggiunta pdUrlF', (e as any)?.message || e);
                            }
                        }
                        if ((channel as any).staticUrlF) {
                            const originalF = (channel as any).staticUrlF;
                            const nameLower = (channel.name || '').toLowerCase().trim();
                            const raiMpdSet = new Set(['rai 1','rai 2','rai 3']); // Solo questi devono passare da proxy MPD
                            // Altri canali RAI (4,5,Movie,Premium, ecc.) restano DIRECT (niente proxy HLS come richiesto)
                            let finalFUrl = originalF;
                            if (mfpUrl && mfpPsw && raiMpdSet.has(nameLower)) {
                                if (!originalF.startsWith(mfpUrl)) {
                                    finalFUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(originalF)}`;
                                }
                            }
                            streams.push({
                                url: finalFUrl,
                                title: `[🌍dTV] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlF ${finalFUrl === originalF ? 'Direct' : 'Proxy(MPD)' }: ${finalFUrl}`);
                        }
                    }

                    // staticUrl (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl && mpdEnabled) {
                        console.log(`🔧 [staticUrl] Raw URL: ${(channel as any).staticUrl}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl);
                        console.log(`🔧 [staticUrl] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[📺HD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][📺HD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl Direct: ${decodedUrl}`);
                        }
                    }
                    // staticUrl2 (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl2 && mpdEnabled) {
                        console.log(`🔧 [staticUrl2] Raw URL: ${(channel as any).staticUrl2}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl2);
                        console.log(`🔧 [staticUrl2] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl2] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl2] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[📽️] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl2 Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][📽️] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl2 Direct: ${decodedUrl}`);
                        }
                    }

                    // staticUrlMpd (sempre attivo se presente, non dipende da enableMpd)
                    if ((channel as any).staticUrlMpd) {
                        console.log(`🔧 [staticUrlMpd] Raw URL: ${(channel as any).staticUrlMpd}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrlMpd);
                        console.log(`🔧 [staticUrlMpd] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpd Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][🎬MPD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpd Direct: ${decodedUrl}`);
                        }
                    }

                    // staticUrlD
                    if ((channel as any).staticUrlD) {
                        if (mfpUrl && mfpPsw) {
                            // Nuova logica: chiama extractor/video con redirect_stream=false, poi costruisci il link proxy/hls/manifest.m3u8
                            const daddyApiBase = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=false&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent((channel as any).staticUrlD)}`;
                            try {
                                const res = await fetch(daddyApiBase);
                                if (res.ok) {
                                    const data = await res.json();
                                    let finalUrl = data.mediaflow_proxy_url || `${mfpUrl}/proxy/hls/manifest.m3u8`;
                                    // Aggiungi i parametri di query se presenti
                                    if (data.query_params) {
                                        const params = new URLSearchParams();
                                        for (const [key, value] of Object.entries(data.query_params)) {
                                            if (value !== null) {
                                                params.append(key, String(value));
                                            }
                                        }
                                        finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
                                    }
                                    // Aggiungi il parametro d per il destination_url
                                    if (data.destination_url) {
                                        const destParam = 'd=' + encodeURIComponent(data.destination_url);
                                        finalUrl += (finalUrl.includes('?') ? '&' : '?') + destParam;
                                    }
                                    // Aggiungi gli header come parametri h_
                                    if (data.request_headers) {
                                        for (const [key, value] of Object.entries(data.request_headers)) {
                                            if (value !== null) {
                                                const headerParam = `h_${key}=${encodeURIComponent(String(value))}`;
                                                finalUrl += '&' + headerParam;
                                            }
                                        }
                                    }
                                    streams.push({
                                        url: finalUrl,
                                        title: `[🌐D] ${channel.name} [ITA]`
                                    });
                                    debugLog(`Aggiunto staticUrlD Proxy (MFP, nuova logica): ${finalUrl}`);
                                } else {
                                    // Nothing returned; avoid adding extractor/video fallback
                                }
                            } catch (err) {
                                // Error; skip extractor/video fallback altogether
                            }
                        } else {
                            streams.push({
                                url: (channel as any).staticUrlD,
                                title: `[❌Proxy][🌐D] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlD Direct: ${(channel as any).staticUrlD}`);
                        }
                    }
                    // Vavoo
                    if (!dynamicHandled && (channel as any).name) {
                        // DEBUG LOGS
                        console.log('🔧 [VAVOO] DEBUG - channel.name:', (channel as any).name);
                        const baseName = (channel as any).name.replace(/\s*(\(\d+\)|\d+)$/, '').trim();
                        console.log('🔧 [VAVOO] DEBUG - baseName:', baseName);
                        const variant2 = `${baseName} (2)`;
                        const variantNum = `${baseName} 2`;
                        console.log('🔧 [VAVOO] DEBUG - variant2:', variant2);
                        console.log('🔧 [VAVOO] DEBUG - variantNum:', variantNum);
                        // --- VAVOO: cerca tutte le varianti .<lettera> per ogni nome in vavooNames (case-insensitive), sia originale che normalizzato ---
                        const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                        // LOG RAW delle chiavi della cache
                        console.log('[VAVOO] CACHE KEYS RAW:', Array.from(vavooCache.links.keys()));
                        console.log(`[VAVOO] CERCA: vavooNamesArr =`, vavooNamesArr);
                        const allCacheKeys = Array.from(vavooCache.links.keys());
                        console.log(`[VAVOO] CACHE KEYS:`, allCacheKeys);
                        const foundVavooLinks: { url: string, key: string }[] = [];
                        for (const vavooName of vavooNamesArr) {
                            // Cerca con nome originale
                            console.log(`[VAVOO] CERCA (original): '${vavooName} .<lettera>'`);
                            const variantRegex = new RegExp(`^${vavooName} \.([a-zA-Z])$`, 'i');
                            for (const [key, value] of vavooCache.links.entries()) {
                                if (variantRegex.test(key)) {
                                    console.log(`[VAVOO] MATCH (original): chiave trovata '${key}' per vavooName '${vavooName}'`);
                                    const links = Array.isArray(value) ? value : [value];
                                    for (const url of links) {
                                        foundVavooLinks.push({ url, key });
                                        console.log(`[VAVOO] LINK trovato (original): ${url} (chiave: ${key})`);
                                    }
                                }
                            }
                            // Cerca anche con nome normalizzato (ma solo se diverso)
                            const vavooNameNorm = vavooName.toUpperCase().replace(/\s+/g, ' ').trim();
                            if (vavooNameNorm !== vavooName) {
                                console.log(`[VAVOO] CERCA (normalizzato): '${vavooNameNorm} .<lettera>'`);
                                const variantRegexNorm = new RegExp(`^${vavooNameNorm} \.([a-zA-Z])$`, 'i');
                                for (const [key, value] of vavooCache.links.entries()) {
                                    const keyNorm = key.toUpperCase().replace(/\s+/g, ' ').trim();
                                    if (variantRegexNorm.test(keyNorm)) {
                                        console.log(`[VAVOO] MATCH (normalizzato): chiave trovata '${key}' per vavooNameNorm '${vavooNameNorm}'`);
                                        const links = Array.isArray(value) ? value : [value];
                                        for (const url of links) {
                                            foundVavooLinks.push({ url, key });
                                            console.log(`[VAVOO] LINK trovato (normalizzato): ${url} (chiave: ${key})`);
                                        }
                                    }
                                }
                            }
                        }
                        // Se trovi almeno un link, aggiungi tutti come stream separati numerati
            if (foundVavooLinks.length > 0) {
                            foundVavooLinks.forEach(({ url, key }, idx) => {
                                const streamTitle = `[✌️ V-${idx + 1}] ${channel.name} [ITA]`;
                                if (mfpUrl && mfpPsw) {
                                    const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                    streams.push({
                                        title: streamTitle,
                                        url: vavooProxyUrl
                                    });
                                } else {
                                    streams.push({
                                        title: `[❌Proxy]${streamTitle}`,
                                        url
                                    });
                                }
                vavooFoundUrls.push(url);
                                // For each found link, also prepare a clean variant labeled per index (➡️ V-1, V-2, ...)
                                const reqObj: any = (global as any).lastExpressRequest;
                                const clientIp = getClientIpFromReq(reqObj);
                                vavooCleanPromises.push((async () => {
                                    vdbg('Variant clean resolve attempt', { index: idx + 1, url: url.substring(0, 140) });
                                    try {
                                        const clean = await resolveVavooCleanUrl(url, clientIp);
                                        if (clean && clean.url) {
                                            const title = `[🏠 V-${idx + 1}] ${channel.name} [ITA]`;
                                            const urlWithHeaders = clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64');
                                            vavooCleanPrepend[idx] = { title, url: urlWithHeaders };
                                        }
                                    } catch (err) {
                                        vdbg('Variant clean failed', { index: idx + 1, error: (err as any)?.message || err });
                                    }
                                })());
                            });
                            console.log(`[VAVOO] RISULTATO: trovati ${foundVavooLinks.length} link, stream generati:`, streams.map(s => s.title));
                        } else {
                            // fallback: chiave esatta
                            const exact = vavooCache.links.get(channel.name);
                            if (exact) {
                                const links = Array.isArray(exact) ? exact : [exact];
                                links.forEach((url, idx) => {
                                    const streamTitle = `[✌️ V-${idx + 1}] ${channel.name} [ITA]`;
                                    if (mfpUrl && mfpPsw) {
                                        const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                        streams.push({
                                            title: streamTitle,
                                            url: vavooProxyUrl
                                        });
                                    } else {
                                        streams.push({
                                            title: `[❌Proxy]${streamTitle}`,
                                            url
                                        });
                                    }
                                    vavooFoundUrls.push(url);
                                    // Prepare clean variant per index as well
                                    const reqObj: any = (global as any).lastExpressRequest;
                                    const clientIp = getClientIpFromReq(reqObj);
                                    vavooCleanPromises.push((async () => {
                                        vdbg('Variant clean resolve attempt', { index: idx + 1, url: url.substring(0, 140) });
                                        try {
                                            const clean = await resolveVavooCleanUrl(url, clientIp);
                                            if (clean && clean.url) {
                                                const title = `[🏠 V-${idx + 1}] ${channel.name} [ITA]`;
                                                const urlWithHeaders = clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64');
                                                vavooCleanPrepend[idx] = { title, url: urlWithHeaders };
                                            }
                                        } catch (err) {
                                            vdbg('Variant clean failed', { index: idx + 1, error: (err as any)?.message || err });
                                        }
                                    })());
                                });
                                console.log(`[VAVOO] RISULTATO: fallback chiave esatta, trovati ${links.length} link, stream generati:`, streams.map(s => s.title));
                            } else {
                                console.log(`[VAVOO] RISULTATO: nessun link trovato per questo canale.`);
                            }
                        }
                    }

                    // Se già gestito come evento dinamico, salta Vavoo/TVTap e ritorna subito
                    if (dynamicHandled) {
                        const allowVavooClean = config.vavooNoMfpEnabled !== false; // default allow; if explicit false hide
                        for (const s of streams) {
                            // Skip any remaining MFP extractor links entirely
                            if (/\/extractor\/video\?/i.test(s.url)) {
                                debugLog('[DynamicStreams] Skipping extractor/video URL in dynamicHandled emit:', s.url);
                                continue;
                            }
                            // Support special marker '#headers#<b64json>' to attach headers properly
                            const marker = '#headers#';
                            if (s.url.includes(marker)) {
                                const [pureUrl, b64] = s.url.split(marker);
                                let hdrs: Record<string, string> | undefined;
                                try { hdrs = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch {}
                            const isVavooClean = !!hdrs && hdrs['Referer'] === 'https://vavoo.to/' && hdrs['User-Agent'] === DEFAULT_VAVOO_UA;
                            if (isVavooClean && !allowVavooClean) { continue; }
                            allStreams.push({ name: isVavooClean ? 'Vavoo🔓' : 'Live 🔴', title: s.title, url: pureUrl, behaviorHints: { notWebReady: true, headers: hdrs || {}, proxyHeaders: hdrs || {}, proxyUseFallback: true } as any });
                            } else {
                            // Fallback: if this looks like a clean Vavoo sunshine URL and title starts with a variant tag, attach default headers
                                const looksVavoo = /\b(sunshine|hls\/index\.m3u8)\b/.test(s.url) && !/\bproxy\/hls\//.test(s.url);
                            const variantTitle = /^\s*\[?\s*(➡️|🏠|✌️)\s*V/i.test(s.title);
                            if (variantTitle && looksVavoo) {
                                    const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string,string>;
                                    if (!allowVavooClean) { continue; }
                                    allStreams.push({ name: 'Vavoo🔓', title: s.title, url: s.url, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any });
                                } else {
                                    allStreams.push({ name: 'Live 🔴', title: s.title, url: s.url });
                                }
                            }
                        }
                        console.log(`✅ Returning ${allStreams.length} dynamic event streams`);
                        return { streams: allStreams };
                    }
                    // --- TVTAP: cerca usando vavooNames ---
                    const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                    console.log(`[TVTap] Cerco canale con vavooNames:`, vavooNamesArr);
                    // tvtapProxyEnabled: TRUE = NO PROXY (mostra 🔓), FALSE = usa proxy se possibile
                    const tvtapNoProxy = !!config.tvtapProxyEnabled;

                    // Prova ogni nome nei vavooNames
                    for (const vavooName of vavooNamesArr) {
                        try {
                            console.log(`[TVTap] Provo con nome: ${vavooName}`);

                            const tvtapUrl = await new Promise<string | null>((resolve) => {
                                const timeout = setTimeout(() => {
                                    console.log(`[TVTap] Timeout per canale: ${vavooName}`);
                                    resolve(null);
                                }, 5000);

                                const options = {
                                    timeout: 5000,
                                    env: {
                                        ...process.env,
                                        PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                                    }
                                };

                                execFile('python3', [path.join(__dirname, '../tvtap_resolver.py'), vavooName], options, (error: Error | null, stdout: string, stderr: string) => {
                                    clearTimeout(timeout);

                                    if (error) {
                                        console.error(`[TVTap] Error for ${vavooName}:`, error.message);
                                        return resolve(null);
                                    }

                                    if (!stdout || stdout.trim() === '') {
                                        console.log(`[TVTap] No output for ${vavooName}`);
                                        return resolve(null);
                                    }

                                    const result = stdout.trim();
                                    if (result === 'NOT_FOUND' || result === 'NO_CHANNELS' || result === 'NO_ID' || result === 'STREAM_FAIL') {
                                        console.log(`[TVTap] Channel not found: ${vavooName} (${result})`);
                                        return resolve(null);
                                    }

                                    if (result.startsWith('http')) {
                                        console.log(`[TVTap] Trovato stream per ${vavooName}: ${result}`);
                                        resolve(result);
                                    } else {
                                        console.log(`[TVTap] Output non valido per ${vavooName}: ${result}`);
                                        resolve(null);
                                    }
                                });
                            });

                            if (tvtapUrl) {
                                const baseTitle = `[📺 TvTap SD] ${channel.name} [ITA]`;
                                if (tvtapNoProxy || !(mfpUrl && mfpPsw)) {
                                    // NO Proxy mode scelto (checkbox ON) oppure mancano credenziali -> link diretto con icona 🔓 senza [❌Proxy]
                                    streams.push({
                                        title: `🔓 ${baseTitle}`,
                                        url: tvtapUrl
                                    });
                                    console.log(`[TVTap] DIRECT (NO PROXY mode=${tvtapNoProxy}) per ${channel.name} tramite ${vavooName}`);
                                } else {
                                    // Checkbox OFF e credenziali presenti -> usa proxy
                                    const tvtapProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(tvtapUrl)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                    streams.push({
                                        title: baseTitle,
                                        url: tvtapProxyUrl
                                    });
                                    console.log(`[TVTap] PROXY stream per ${channel.name} tramite ${vavooName}`);
                                }
                                break; // Esci dal loop se trovi un risultato
                            }
                        } catch (error) {
                            console.error(`[TVTap] Errore per vavooName ${vavooName}:`, error);
                        }
                    }

                    if (streams.length === 0) {
                        console.log(`[TVTap] RISULTATO: nessun stream trovato per ${channel.name}`);
                    }

                    // ============ END INTEGRATION SECTIONS ============

                    // Attendi eventuali risoluzioni clean Vavoo prima di restituire
                    if (vavooCleanPromises.length) {
                        try { await Promise.allSettled(vavooCleanPromises); } catch {}
                        // Prepend clean Vavoo variants in order (V-1 first)
                        let inserted = 0;
                        vdbg('Clean prepend result', { inserted, totalVariants: vavooCleanPrepend.length });
                        for (let i = vavooCleanPrepend.length - 1; i >= 0; i--) {
                            const entry = vavooCleanPrepend[i];
                            if (entry) { streams.unshift(entry); inserted++; }
                        }
                        // If none resolved clean, add numbered fallbacks with default headers for visibility
            if (inserted === 0 && vavooFoundUrls.length > 0) {
                            for (let i = vavooFoundUrls.length - 1; i >= 0; i--) {
                                const u = vavooFoundUrls[i];
                                const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string,string>;
                                const urlWithHeaders = u + `#headers#` + Buffer.from(JSON.stringify(hdrs)).toString('base64');
                streams.unshift({ title: `[🏠 V-${i + 1}] ${channel.name} [ITA]`, url: urlWithHeaders });
                            }
                        }
                    }
                    // Dopo aver popolato streams (nella logica TV):
                    for (const s of streams) {
                        // Drop any extractor/video links
                        if (/\/extractor\/video\?/i.test(s.url)) {
                            debugLog('[Streams] Skipping extractor/video URL in final emit:', s.url);
                            continue;
                        }
                        const allowVavooClean = config.vavooNoMfpEnabled !== false;
                        const marker = '#headers#';
                        if (s.url.includes(marker)) {
                            const [pureUrl, b64] = s.url.split(marker);
                            let hdrs: Record<string, string> | undefined;
                            try { hdrs = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch {}
                            const isVavooClean = !!hdrs && hdrs['Referer'] === 'https://vavoo.to/' && hdrs['User-Agent'] === DEFAULT_VAVOO_UA;
                            if (isVavooClean && !allowVavooClean) { continue; }
                            allStreams.push({ name: isVavooClean ? 'Vavoo🔓' : 'Live 🔴', title: s.title, url: pureUrl, behaviorHints: { notWebReady: true, headers: hdrs || {}, proxyHeaders: hdrs || {}, proxyUseFallback: true } as any });
                        } else {
                            const looksVavoo = /\b(sunshine|hls\/index\.m3u8)\b/.test(s.url) && !/\bproxy\/hls\//.test(s.url);
                            const variantTitle = /^\s*\[?\s*(➡️|🏠|✌️)\s*V/i.test(s.title);
                            if (variantTitle && looksVavoo) {
                                const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string,string>;
                                if (!allowVavooClean) { continue; }
                                allStreams.push({ name: 'Vavoo🔓', title: s.title, url: s.url, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any });
                            } else {
                                allStreams.push({ name: 'Live 🔴', title: s.title, url: s.url });
                            }
                        }
                    }

                    // 5. AGGIUNGI STREAM ALTERNATIVI/FALLBACK per canali specifici
                    // RIMOSSO: Blocco che aggiunge fallback stream alternativi per canali Sky (skyFallbackUrls) se finalStreams.length < 3
                    // return { streams: finalStreamsWithRealUrls };
                }

                // === LOGICA ANIME/FILM (originale) ===
                // Per tutto il resto, usa solo mediaFlowProxyUrl/mediaFlowProxyPassword
                // Gestione AnimeUnity per ID Kitsu o MAL con fallback variabile ambiente
                // Provider flags: default ON unless explicitly disabled
                const envFlag = (name: string) => {
                    const v = process.env[name];
                    if (v == null) return undefined;
                    return v.toLowerCase() === 'true';
                };
                // New rule: enabled only when checkbox true (or env forces true)
                const animeUnityEnabled = envFlag('ANIMEUNITY_ENABLED') ?? (config.animeunityEnabled === true);
                const animeSaturnEnabled = envFlag('ANIMESATURN_ENABLED') ?? (config.animesaturnEnabled === true);
                const animeWorldEnabled = envFlag('ANIMEWORLD_ENABLED') ?? (config.animeworldEnabled === true);
                const guardaSerieEnabled = envFlag('GUARDASERIE_ENABLED') ?? (config.guardaserieEnabled === true);
                const guardaHdEnabled = envFlag('GUARDAHD_ENABLED') ?? (config.guardahdEnabled === true);
                const cb01Enabled = envFlag('CB01_ENABLED') ?? (config as any).cb01Enabled === true;
                const streamingWatchEnabled = envFlag('STREAMINGWATCH_ENABLED') ?? (config as any).streamingwatchEnabled === true;
                // Eurostreaming: default ON unless explicitly disabled (config false) or env sets true/false
                const eurostreamingEnv = envFlag('EUROSTREAMING_ENABLED');
                const eurostreamingEnabled = eurostreamingEnv !== undefined
                    ? eurostreamingEnv
                    : (config.eurostreamingEnabled !== false); // default true
                // Nuovo flag per inserire VixSrc nell'esecuzione parallela (prima era fuori e poteva saltare)
                const vixsrcEnabled = (() => {
                    try {
                        const cfg3 = { ...configCache } as AddonConfig;
                        if (cfg3.disableVixsrc === true) return false;
                    } catch {}
                    return true; // default ON
                })();
                let vixsrcScheduled = false; // per evitare doppia esecuzione nel blocco sequenziale più sotto

                // Gestione parallela AnimeUnity / AnimeSaturn / AnimeWorld
                if ((id.startsWith('kitsu:') || id.startsWith('mal:') || id.startsWith('tt') || id.startsWith('tmdb:')) && (animeUnityEnabled || animeSaturnEnabled || animeWorldEnabled || guardaSerieEnabled || guardaHdEnabled || eurostreamingEnabled || vixsrcEnabled)) {
                    const animeUnityConfig: AnimeUnityConfig = {
                        enabled: animeUnityEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    const animeSaturnConfig = {
                        enabled: animeSaturnEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        mfpProxyUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpProxyPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    const animeWorldConfig = {
                        enabled: animeWorldEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    // Parsing stagione/episodio per IMDB/TMDB
                    let seasonNumber: number | null = null;
                    let episodeNumber: number | null = null;
                    let isMovie = false;
                    if (id.startsWith('tt') || id.startsWith('tmdb:')) {
                        // Esempio: tt1234567:1:2 oppure tmdb:12345:1:2
                        const parts = id.split(':');
                        if (parts.length === 1) {
                            isMovie = true;
                        } else if (parts.length === 2) {
                            episodeNumber = parseInt(parts[1]);
                        } else if (parts.length === 3) {
                            seasonNumber = parseInt(parts[1]);
                            episodeNumber = parseInt(parts[2]);
                        }
                    }
                    const providerPromises: Promise<void>[] = [];

                    const runProvider = async (name: string, enabled: boolean, handler: () => Promise<{ streams: Stream[] }>, streamName: string, isMixdropSensitive = false) => {
                        if (enabled) {
                            try {
                                const result = await handler();
                                if (result && result.streams) {
                                    for (const s of result.streams) {
                                        if (isMixdropSensitive) {
                                            const isMixdrop = s.title ? /\b(mixdrop|streamtape)\b/i.test(s.title) : false;
                                            allStreams.push({ ...s, name: isMixdrop ? streamName.replace(' 🔓', '') : streamName });
                                        } else {
                                            allStreams.push({ ...s, name: streamName });
                                        }
                                    }
                                }
                            } catch (error) {
                                console.error(`🚨 ${name} error:`, error);
                            }
                        }
                    };

                    // VixSrc PRIMA di tutti (se abilitato)
                    if (vixsrcEnabled && !id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
                        vixsrcScheduled = true;
                        providerPromises.push(runProvider('VixSrc', true, async () => {
                            const finalConfig: ExtractorConfig = {
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                                mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                                vixLocal: !!config.vixLocal,
                                vixDual: !!(config as any)?.vixDual,
                                addonBase: (config as any)?.addonBase || ( () => {
                                    try {
                                        const proto = (process.env.EXTERNAL_PROTOCOL || 'https');
                                        const host = (process.env.EXTERNAL_HOST || process.env.HOST || process.env.VERCEL_URL || '').replace(/\/$/,'');
                                        if (host) return `${proto}://${host}`;
                                        return '';
                                    } catch { return ''; }
                                })()
                            };
                            console.log('[VixSrc][ParallelConfig]', { vixLocal: finalConfig.vixLocal, vixDual: finalConfig.vixDual, addonBase: finalConfig.addonBase });
                            const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);
                            if (!res) return { streams: [] };
                            const fmtBytes = (n: number): string => {
                                const units = ['B','KB','MB','GB','TB'];
                                let v = n; let u = 0; while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
                                return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
                            };
                            const streams: Stream[] = [];
                            for (const st of res) {
                                if (!st.streamUrl) continue;
                                let adjustedName = st.name || '';
                                adjustedName = adjustedName.replace(/\s*•\s*\[ITA\]$/i, ' • [ITA]');
                                adjustedName = adjustedName.replace(/\s*\[ITA\]$/i, ' • [ITA]');
                                let finalTitle = adjustedName;
                                if (typeof st.sizeBytes === 'number') {
                                    const sizeLabel = st.sizeBytes > 0 ? fmtBytes(st.sizeBytes) : '?';
                                    finalTitle = `${adjustedName}\n💾 ${sizeLabel}`;
                                }
                                streams.push({ title: finalTitle, url: st.streamUrl, behaviorHints: { notWebReady: true, headers: { Referer: st.referer } } as any });
                            }
                            return { streams };
                        }, 'StreamViX Vx'));
                    }

                    // AnimeUnity
                    providerPromises.push(runProvider('AnimeUnity', animeUnityEnabled, async () => {
                        const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                        if (id.startsWith('kitsu:')) return animeUnityProvider.handleKitsuRequest(id);
                        if (id.startsWith('mal:')) return animeUnityProvider.handleMalRequest(id);
                        if (id.startsWith('tt')) return animeUnityProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        if (id.startsWith('tmdb:')) return animeUnityProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        return { streams: [] };
                    }, 'StreamViX AU'));

                    // AnimeSaturn
                    providerPromises.push(runProvider('AnimeSaturn', animeSaturnEnabled, async () => {
                        const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                        const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                        if (id.startsWith('kitsu:')) return animeSaturnProvider.handleKitsuRequest(id);
                        if (id.startsWith('mal:')) return animeSaturnProvider.handleMalRequest(id);
                        if (id.startsWith('tt')) return animeSaturnProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        if (id.startsWith('tmdb:')) return animeSaturnProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        return { streams: [] };
                    }, 'StreamViX AS'));

                    // AnimeWorld
                    providerPromises.push(runProvider('AnimeWorld', animeWorldEnabled, async () => {
                        const { AnimeWorldProvider } = await import('./providers/animeworld-provider');
                        const animeWorldProvider = new AnimeWorldProvider(animeWorldConfig);
                        if (id.startsWith('kitsu:')) return animeWorldProvider.handleKitsuRequest(id);
                        if (id.startsWith('mal:')) return animeWorldProvider.handleMalRequest(id);
                        if (id.startsWith('tt')) return animeWorldProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        if (id.startsWith('tmdb:')) return animeWorldProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        return { streams: [] };
                    }, 'StreamViX AW'));

                    // GuardaSerie
                    if (guardaSerieEnabled && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
                        providerPromises.push(runProvider('GuardaSerie', true, async () => {
                            const { GuardaSerieProvider } = await import('./providers/guardaserie-provider');
                            const gsProvider = new GuardaSerieProvider({
                                enabled: true,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || ''
                            });
                            if (id.startsWith('tt')) return gsProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            if (id.startsWith('tmdb:')) return gsProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            return { streams: [] };
                        }, 'StreamViX GS 🔓'));
                    }

                    // GuardaHD
                    if (guardaHdEnabled && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
                        providerPromises.push(runProvider('GuardaHD', true, async () => {
                            const { GuardaHdProvider } = await import('./providers/guardahd-provider');
                            const ghProvider = new GuardaHdProvider({
                                enabled: true,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || ''
                            });
                            if (id.startsWith('tt')) return ghProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            if (id.startsWith('tmdb:')) return ghProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            return { streams: [] };
                        }, 'StreamViX GH 🔓', true));
                    }

                    // CB01 (Mixdrop only)
                    if (cb01Enabled && (id.startsWith('tt'))) {
                        providerPromises.push(runProvider('CB01', true, async () => {
                            const { Cb01Provider } = await import('./providers/cb01-provider');
                            const cbProvider = new Cb01Provider({
                                enabled: true,
                                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                            });
                            return cbProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        }, 'StreamViX CB', true));
                    }

                    // StreamingWatch (nuovo provider) - supporta film e serie
                    if (streamingWatchEnabled && id.startsWith('tt')) {
                        providerPromises.push(runProvider('StreamingWatch', true, async () => {
                            const { StreamingWatchProvider } = await import('./providers/streamingwatch-provider');
                            const swProvider = new StreamingWatchProvider({
                                enabled: true,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                            });
                            return swProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        }, 'StreamViX SW 🔓'));
                    }

                    // Eurostreaming
                    if (eurostreamingEnabled && id.startsWith('tt') && seasonNumber != null && episodeNumber != null) {
                        providerPromises.push(runProvider('Eurostreaming', true, async () => {
                            const { EurostreamingProvider } = await import('./providers/eurostreaming-provider');
                            const esProvider = new EurostreamingProvider({
                                enabled: true,
                                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                            });
                            return esProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        }, 'StreamViX ES 🔓', true));
                    }


                    await Promise.all(providerPromises);
                }

                // Mantieni logica VixSrc per tutti gli altri ID (solo se non già eseguita in parallelo)
                if (!vixsrcScheduled && !id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
                    console.log(`📺 Processing non-Kitsu or MAL ID with VixSrc: ${id}`);
                    // Gate VixSrc by config flag (default ON if absent)
                    try {
                        const cfg3 = { ...configCache } as AddonConfig;
                        if (cfg3.disableVixsrc === true) {
                            console.log('⛔ VixSrc disabled by config.disableVixsrc=true');
                            return { streams: allStreams };
                        }
                    } catch {}

                    const finalConfig: ExtractorConfig = {
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                        mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                        vixLocal: !!config.vixLocal,
                        vixDual: !!(config as any)?.vixDual,
                        addonBase: (config as any)?.addonBase || (()=>{
                            try {
                                const proto = (process.env.EXTERNAL_PROTOCOL || 'https');
                                const host = (process.env.EXTERNAL_HOST || process.env.HOST || process.env.VERCEL_URL || '').replace(/\/$/,'');
                                if (host) return `${proto}://${host}`;
                                return '';
                            } catch { return ''; }
                        })()
                    };

                    const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);

                    if (res) {
                        // helper: compact bytes format (e.g., 123.4 MB)
                        const fmtBytes = (n: number): string => {
                            const units = ['B','KB','MB','GB','TB'];
                            let v = n;
                            let u = 0;
                            while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
                            return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
                        };
                        for (const st of res) {
                            if (st.streamUrl == null) continue;

                            // Costruisci il title: mantieni il nome invariato, e SOLO per VixSrc aggiungi sotto la riga 💾 size
                            let adjustedVariant = st.name || '';
                            adjustedVariant = adjustedVariant.replace(/\s*•\s*\[ITA\]$/i, ' • [ITA]');
                            adjustedVariant = adjustedVariant.replace(/\s*\[ITA\]$/i, ' • [ITA]');
                            let finalTitle = adjustedVariant;
                            if (typeof st.sizeBytes === 'number') {
                                const sizeLabel = st.sizeBytes > 0 ? fmtBytes(st.sizeBytes) : '?';
                                finalTitle = `${adjustedVariant}\n💾 ${sizeLabel}`;
                            }

                            // Nome mostrato nella lista: includi prefisso provider per mantenere reorder, più variante distinta
                            const providerPrefix = 'StreamViX Vx';
                            const streamName = `${providerPrefix} | ${adjustedVariant}`.trim();

                            console.log(`Adding VixSrc stream variant: name="${streamName}" title="${finalTitle}" url=${st.streamUrl.split('?')[0]}`);

                            allStreams.push({
                                title: finalTitle,
                                name: streamName,
                                url: st.streamUrl,
                                behaviorHints: {
                                    notWebReady: true,
                                    headers: { "Referer": st.referer },
                                },
                            });
                        }
                        console.log(`📺 VixSrc streams found: ${res.length}`);
                    }
                }

                // Reorder: ensure VixSrc (StreamViX Vx) streams always first
                try {
                    const vix: Stream[] = [];
                    const others: Stream[] = [];
                    for (const s of allStreams) {
                        const n = (s as any)?.name || (s as any)?.title || '';
                        if (typeof n === 'string' && /StreamViX\s+Vx/i.test(n)) vix.push(s); else others.push(s);
                    }
                    if (vix.length) {
                        // mutate in place (allStreams is const reference)
                        allStreams.splice(0, allStreams.length, ...vix, ...others);
                    }
                } catch(e) { /* silent */ }
                console.log(`✅ Total streams returned: ${allStreams.length}`);
                return { streams: allStreams };
            } catch (error) {
                console.error('Stream extraction failed:', error);
                return { streams: [] };
            }
        }
    );

    return builder;
}

// Server Express
const app = express();
// Trust proxy chain so req.ip / req.ips use X-Forwarded-For correctly when behind a proxy/CDN
try { (app as any).set('trust proxy', true); } catch {}

// PRIORITY: Configure routes must be first to avoid conflicts with global router
// Single, minimal Configure handler: '/{config}/configure'
app.get(/^\/(.+)\/configure\/?$/, (req: Request, res: Response) => {
    try {
        const base = loadCustomConfig();
        // First capture group includes everything between the first slash and '/configure'
        const between = (req.params as any)[0] as string;
        const rawQueryCfg = typeof req.query.config === 'string' ? (req.query.config as string) : undefined;
        const cfgFromUrl = between ? parseConfigFromArgs(between) : (rawQueryCfg ? parseConfigFromArgs(rawQueryCfg) : {});
        const manifestWithDefaults: any = { ...base };
        if (Array.isArray(manifestWithDefaults.config)) {
            manifestWithDefaults.config = manifestWithDefaults.config.map((c: any) => {
                const val = (cfgFromUrl as any)?.[c?.key];
                if (typeof val !== 'undefined') return { ...c, default: c.type === 'checkbox' ? !!val : String(val) };
                return c;
            });
        }
        res.setHeader('Content-Type', 'text/html');
        return res.send(landingTemplate(manifestWithDefaults));
    } catch (e) {
        console.error('❌ Configure (regex) error:', (e as any)?.message || e);
        const manifest = loadCustomConfig();
        res.setHeader('Content-Type', 'text/html');
        return res.send(landingTemplate(manifest));
    }
});


app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Redirect convenience: allow /stream/tv/<id> (no .json) -> proper .json endpoint
app.get('/stream/tv/:id', (req: Request, res: Response, next: NextFunction) => {
    // Se già termina con .json non fare nulla
    if (req.originalUrl.endsWith('.json')) return next();
    const id = req.params.id;
    const q = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const target = `/stream/tv/${id}.json${q}`;
    res.redirect(302, target);
});

// Salva l'ultima request Express per fallback nel catalog handler (quando il router interno non passa req)
app.use((req: Request, _res: Response, next: NextFunction) => {
    (global as any).lastExpressRequest = req;
    next();
});

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest: any = loadCustomConfig();
    try {
        // Resolve addon base exactly like extractor fallback chain
        const envBase = process.env.ADDON_BASE_URL || process.env.STREAMVIX_ADDON_BASE || '';
        const DEFAULT_ADDON_BASE = 'https://streamvix.hayd.uk';
        let resolved = '';
        if (manifest && typeof manifest === 'object' && manifest.addonBase) {
            resolved = String(manifest.addonBase);
        }
        if (!resolved && envBase && envBase.startsWith('http')) {
            resolved = envBase.replace(/\/$/, '');
        }
        if (!resolved) {
            resolved = DEFAULT_ADDON_BASE; // final fallback (mirrors extractor.ts logic)
        }
        manifest.__resolvedAddonBase = resolved; // inject for landing page display only (not part of config serialization)
    } catch (e) {
        console.warn('[Landing] addonBase resolution failed:', (e as any)?.message || e);
    }
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// Serve manifest dynamically so we can hide TV catalog when disableLiveTv is true
// Also supports config passed via path segment or query string (?config=...)
// CORS for manifest endpoints
app.options(['/manifest.json', '/:config/manifest.json', '/cfg/:config/manifest.json'], (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(204);
});

app.get(['/manifest.json', '/:config/manifest.json', '/cfg/:config/manifest.json'], (req: Request, res: Response) => {
    try {
        const base = loadCustomConfig();
    // Parse optional config from URL segment OR query string (?config=...)
    const rawParamCfg = (req.params as any)?.config;
    const rawQueryCfg = typeof req.query.config === 'string' ? (req.query.config as string) : undefined;
    const cfgFromUrl = rawParamCfg ? parseConfigFromArgs(rawParamCfg) : (rawQueryCfg ? parseConfigFromArgs(rawQueryCfg) : {});
        // Build a manifest copy with defaults prefilled from cfgFromUrl or runtime cache
        const manifestWithDefaults: any = { ...base };
        const sourceCfg = (cfgFromUrl && Object.keys(cfgFromUrl).length) ? cfgFromUrl : (configCache as any);
        if (Array.isArray(manifestWithDefaults.config) && manifestWithDefaults.config.length) {
            manifestWithDefaults.config = manifestWithDefaults.config.map((c: any) => {
                const key = c?.key;
                if (!key) return c;
                const val = (sourceCfg as any)?.[key];
                if (typeof val !== 'undefined') {
                    if (c.type === 'checkbox') return { ...c, default: !!val };
                    else return { ...c, default: String(val) };
                }
                return c;
            });
        }
        const effectiveDisable = (cfgFromUrl as any)?.disableLiveTv ?? (configCache as any)?.disableLiveTv;
        const filtered: Manifest = { ...manifestWithDefaults } as Manifest;
        if (!Array.isArray((filtered as any).catalogs)) (filtered as any).catalogs = [];
        if (effectiveDisable) {
            const cats = Array.isArray(filtered.catalogs) ? filtered.catalogs.slice() : [];
            filtered.catalogs = cats.filter(c => !(c && (c as any).id === 'streamvix_tv'));
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.json(filtered);
    } catch (e: any) {
        console.error('❌ Manifest route error:', e?.message || e);
    const fallback = loadCustomConfig();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.json(fallback);
    }
});

// Endpoint sintetico: genera mini-master con sola variante video massima e traccia AUDIO italiana
app.get('/vixsynthetic', async (req: Request, res: Response) => {
    try {
        const src = typeof req.query.src === 'string' ? req.query.src : '';
        if (!src) return res.status(400).send('#EXTM3U\n# Missing src');
        const langPref = ((req.query.lang as string) || 'it').toLowerCase();
        const multiFlag = (()=>{
            const m = String(req.query.multi||'').toLowerCase();
            if (['1','true','on','yes','all'].includes(m)) return true;
            if (String(req.query.languages||'').toLowerCase()==='all') return true;
            return false;
        })();
        if (multiFlag) console.log('[vixsynthetic] multi-language mode attivo');
        const r = await fetch(src, { headers: { 'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' } as any });
        if (!r.ok) return res.status(502).send('#EXTM3U\n# Upstream error');
        const text = await r.text();
        // Se non è master, restituisci com'è
        if (!/#EXT-X-STREAM-INF:/i.test(text)) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }
        const lines = text.split(/\r?\n/);
        interface Variant { url: string; height: number; bandwidth: number; info: string; };
        const variants: Variant[] = [];
        const media: { line: string; attrs: Record<string,string>; }[] = [];
        const parseAttrs = (l: string): Record<string,string> => {
            const out: Record<string,string> = {}; l.replace(/([A-Z0-9-]+)=(("[^"]+")|([^,]+))/g, (_m, k, v) => { const val = String(v).replace(/^"|"$/g,''); out[k]=val; return ''; }); return out;
        };
        for (let i=0;i<lines.length;i++) {
            const l = lines[i];
            if (l.startsWith('#EXT-X-MEDIA:')) {
                media.push({ line: l, attrs: parseAttrs(l) });
            }
            if (l.startsWith('#EXT-X-STREAM-INF:')) {
                const info = l;
                const next = lines[i+1] || '';
                if (!next || next.startsWith('#')) continue;
                const attrs = parseAttrs(info);
                let h = 0; let bw = 0;
                if (attrs['RESOLUTION']) {
                    const m = attrs['RESOLUTION'].match(/(\d+)x(\d+)/); if (m) h = parseInt(m[2],10)||0;
                }
                if (attrs['BANDWIDTH']) bw = parseInt(attrs['BANDWIDTH'],10)||0;
                // Resolve relative
                let vUrl = next.trim();
                try { vUrl = new URL(vUrl, src).toString(); } catch {}
                variants.push({ url: vUrl, height: h, bandwidth: bw, info });
            }
        }
        if (!variants.length) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }
        variants.sort((a,b)=> (b.height - a.height) || (b.bandwidth - a.bandwidth));
        const best = variants[0];
        const header: string[] = ['#EXTM3U'];
        const copyTags = ['#EXT-X-VERSION','#EXT-X-INDEPENDENT-SEGMENTS'];
        for (const t of copyTags) { if (text.includes(t)) header.push(t); }

        if (multiFlag) {
            // In modalità multi includiamo tutte le righe #EXT-X-MEDIA (AUDIO e SUBTITLES) e manteniamo il GROUP-ID originale.
            const audioGroupsEncountered: Set<string> = new Set();
            const subtitleGroupsEncountered: Set<string> = new Set();
            for (const m of media) {
                const type = (m.attrs['TYPE']||'').toUpperCase();
                if (type === 'AUDIO') {
                    header.push(m.line);
                    if (m.attrs['GROUP-ID']) audioGroupsEncountered.add(m.attrs['GROUP-ID']);
                } else if (type === 'SUBTITLES') {
                    header.push(m.line);
                    if (m.attrs['GROUP-ID']) subtitleGroupsEncountered.add(m.attrs['GROUP-ID']);
                }
            }
            // Forziamo la variante best ad usare il primo gruppo audio se presente
            let streamInf = best.info;
            if (audioGroupsEncountered.size) {
                const firstAudio = [...audioGroupsEncountered][0];
                if (/AUDIO="/.test(streamInf)) streamInf = streamInf.replace(/AUDIO="[^"]+"/, `AUDIO="${firstAudio}"`);
                else streamInf = streamInf.replace('#EXT-X-STREAM-INF:', `#EXT-X-STREAM-INF:AUDIO="${firstAudio}",`);
            }
            header.push(streamInf);
            header.push(best.url);
        } else {
            // Modalità singola (compatibile precedente): seleziona solo la traccia richiesta (langPref)
            let chosenGroup: string | null = null;
            let chosenMediaLine: string | null = null;
            for (const m of media) {
                const type = (m.attrs['TYPE']||'').toUpperCase();
                if (type !== 'AUDIO') continue;
                const lang = (m.attrs['LANGUAGE']||'').toLowerCase();
                const name = (m.attrs['NAME']||'').toLowerCase();
                if (lang === langPref || name.includes(langPref)) {
                    chosenGroup = m.attrs['GROUP-ID'] || null;
                    chosenMediaLine = m.line;
                    break;
                }
            }
            if (!chosenGroup && media.length) {
                const firstAudio = media.find(m=> (m.attrs['TYPE']||'').toUpperCase()==='AUDIO');
                if (firstAudio) { chosenGroup = firstAudio.attrs['GROUP-ID']||null; chosenMediaLine = firstAudio.line; }
            }
            if (chosenMediaLine && chosenGroup) header.push(chosenMediaLine);
            let streamInf = best.info;
            if (chosenGroup) {
                if (/AUDIO="/.test(streamInf)) streamInf = streamInf.replace(/AUDIO="[^"]+"/, `AUDIO="${chosenGroup}"`);
                else streamInf = streamInf.replace('#EXT-X-STREAM-INF:', `#EXT-X-STREAM-INF:AUDIO="${chosenGroup}",`);
            }
            header.push(streamInf);
            header.push(best.url);
        }
        const mini = header.join('\n') + '\n';
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(mini);
    } catch (e) {
        console.error('[vixsynthetic] error:', (e as any)?.message || e);
        res.status(500).send('#EXTM3U\n# internal error');
    }
});

// ✅ Middleware semplificato che usa sempre il router globale
app.use((req: Request, res: Response, next: NextFunction) => {
    // ...
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    try {
        const observedIp = getClientIpFromReq(req);
        if (observedIp) vdbg('Observed client IP', { observedIp, reqIp: (req as any).ip, reqIps: (req as any).ips });
    } catch {}

    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);

    // ...

    // Parse configuration from URL path segment once (before TV logic)
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('🔧 Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('🔧 Updated global config cache:', configCache);
        }
    }

    // Per le richieste di stream TV, assicurati che la configurazione proxy sia sempre presente
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        // Non applicare più nessun fallback hardcoded
        // if (!configCache.mfpProxyUrl || !configCache.mfpProxyPassword) { ... } // RIMOSSO
        debugLog('📺 Current proxy config for TV streams:', configCache);
    }

    // ...

    // PATCH: Inject full search query for AnimeWorld catalog search
    if (
        req.path === '/catalog/animeworld/anime/search.json' &&
        req.query && typeof req.query.query === 'string'
    ) {
        debugLog('🔎 PATCH: Injecting full search query from req.query.query:', req.query.query);
        // Ensure req.query.extra is always an object
        let extraObj: any = {};
        if (req.query.extra) {
            if (typeof req.query.extra === 'string') {
                try {
                    extraObj = JSON.parse(req.query.extra);
                } catch (e) {
                    extraObj = {};
                }
            } else if (typeof req.query.extra === 'object') {
                extraObj = req.query.extra;
            }
        }
        extraObj.search = req.query.query;
        req.query.extra = extraObj;
    }

    // ✅ Inizializza il router globale se non è ancora stato fatto
    const currentDisable = !!(configCache as any)?.disableLiveTv;
    const needRebuild = (!globalRouter) || (lastDisableLiveTvFlag !== currentDisable);
    if (needRebuild) {
        if (globalRouter) console.log('🔁 Rebuilding addon router due to config change (disableLiveTv=%s)', currentDisable);
        else console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache);
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        lastDisableLiveTvFlag = currentDisable;
        console.log('✅ Global router %s', needRebuild ? 'initialized/updated' : 'initialized');
    }

    // USA SEMPRE il router globale
    globalRouter(req, res, next);
});


// ============ TVTAP RESOLVE ENDPOINT ============
// Endpoint per risolvere i link TVTap in tempo reale
app.get('/tvtap-resolve/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    console.log(`[TVTap] Richiesta risoluzione per canale ID: ${channelId}`);

    try {
        // Chiama lo script Python per ottenere il link stream
        const timeout = setTimeout(() => {
            console.log(`[TVTap] Timeout per canale ID: ${channelId}`);
            res.status(408).json({ error: 'TVTap timeout' });
        }, 10000);

        const options = {
            timeout: 10000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };

        execFile('python3', [
            path.join(__dirname, '../tvtap_resolver.py'),
            // Se channelId è un numero, usa il formato tvtap_id:, altrimenti cerca per nome
            /^\d+$/.test(channelId) ? `tvtap_id:${channelId}` : channelId
        ], options, (error: Error | null, stdout: string, stderr: string) => {
            clearTimeout(timeout);

            if (error) {
                console.error(`[TVTap] Error resolving channel ${channelId}:`, error.message);
                if (stderr) console.error(`[TVTap] Stderr:`, stderr);
                return res.status(500).json({ error: 'TVTap resolution failed' });
            }

            if (!stdout || stdout.trim() === '') {
                console.log(`[TVTap] No output for channel ${channelId}`);
                return res.status(404).json({ error: 'TVTap stream not found' });
            }

            const streamUrl = stdout.trim();
            console.log(`[TVTap] Resolved channel ${channelId} to: ${streamUrl.substring(0, 50)}...`);

            // Redirigi al link stream
            res.redirect(streamUrl);
        });

    } catch (error) {
        console.error(`[TVTap] Exception resolving channel ${channelId}:`, error);
        res.status(500).json({ error: 'TVTap resolution exception' });
    }
});

// ================= SIMPLE IP HEALTH CHECK =================
// Parity with upstream webstreamr /live ipStatus logic but limited to MostraGuarda only.
let liveProbeLastTs = 0;
let liveProbeBlocked = 0;
let liveProbeErrors = 0;
async function runIpProbe(force = false) {
    if (!force && Date.now() - liveProbeLastTs < 60000) return; // throttle 60s
    liveProbeBlocked = 0;
    liveProbeErrors = 0;
    try {
        await fetchPage('https://mostraguarda.stream', { noCache: true });
    } catch (e: any) {
        const msg = (e?.message || '').toString();
        if (/cloudflare_challenge/i.test(msg) || /http_403/.test(msg) || /(^|[^0-9])403([^0-9]|$)/.test(msg)) liveProbeBlocked++;
        else liveProbeErrors++;
    }
    liveProbeLastTs = Date.now();
}

// GET /live[?forceIpCheck]
app.get('/live', async (req: Request, res: Response) => {
    const force = 'forceIpCheck' in req.query;
    await runIpProbe(force);
    if (liveProbeBlocked > 0) {
        return res.json({ status: 'ok', ipStatus: 'error' });
    }
    if (liveProbeErrors > 0) {
        return res.status(503).json({ status: 'error' });
    }
    return res.json({ status: 'ok', ipStatus: 'ok' });
});

// ================= MANUAL LIVE UPDATE ENDPOINT =================
// GET /live/update?token=XYZ (token optional if LIVE_UPDATE_TOKEN not set)
app.get('/live/update', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.LIVE_UPDATE_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
    // Esegue Live.py immediatamente (se esiste)
    // Riutilizza executeLiveScript già definita nello scheduler e recupera stdout/stderr
    const execRes = await (async () => { try { return await (executeLiveScript as any)(); } catch { return undefined; } })();
    // Subito dopo Live.py: esegui purge per rimuovere eventi vecchi, mantenendo IERI fino alle 08:00 Rome
    const purgeResult = purgeOldDynamicEvents();
    // Ricarica sempre i canali dinamici dopo il purge
    const dyn = loadDynamicChannels(true);
    const dynPath = getDynamicFilePath();
    const dynStats = getDynamicFileStats();
        // Risposta arricchita con conteggio e uno snippet di stdout/stderr
        const liveStdout: string | undefined = execRes?.stdout ? String(execRes.stdout) : undefined;
        const liveStderr: string | undefined = execRes?.stderr ? String(execRes.stderr) : undefined;
        // Prova a estrarre "Creati X eventi dinamici" dall'output di Live.py
        let createdCount: number | undefined;
        if (liveStdout) {
            try {
                const m = liveStdout.match(/Creati\s+(\d+)\s+eventi\s+dinamici/i);
                if (m) createdCount = parseInt(m[1], 10);
            } catch {}
        }
        const clip = (s?: string) => s ? (s.length > 800 ? s.slice(-800) : s) : undefined; // prendi ultime 800 chars
        return res.json({
            ok: true,
            message: `Live.py eseguito (se presente), purge effettuato e canali ricaricati: eventi dinamici=${dyn.length}${createdCount!=null?` (creati=${createdCount})`:''}`,
            dynamicCount: dyn.length,
            createdCount,
            purge: purgeResult,
            dynamicFile: {
                path: dynPath,
                exists: dynStats.exists,
                size: dynStats.size,
                mtime: dynStats.mtimeMs ? new Date(dynStats.mtimeMs).toISOString() : null
            },
            liveStdout: clip(liveStdout),
            liveStderr: clip(liveStderr),
            // eventsRaw: ritorna gli eventi dinamici "grezzi" come richiesto.
            // Per evitare payload eccessivi si può passare ?truncate=1 per includere solo campi chiave.
            eventsRaw: (() => {
                const wantTrunc = 'truncate' in req.query && req.query.truncate !== '0';
                if (!Array.isArray(dyn)) return [];
                if (!wantTrunc) return dyn; // full objects
                return dyn.map(ev => ({
                    id: ev.id,
                    name: ev.name,
                    eventStart: ev.eventStart,
                    category: ev.category,
                    streamsCount: Array.isArray(ev.streams) ? ev.streams.length : 0
                }));
            })()
        });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// ================= MANUAL RELOAD ENDPOINT =====================
// Invalida la cache dinamica e forza una ricarica
app.get('/live/reload', (_: Request, res: Response) => {
    try {
        invalidateDynamicChannels();
        const dyn = loadDynamicChannels(true);
        console.log(`🔄 /live/reload eseguito: canali dinamici attuali=${dyn.length}`);
        res.json({ ok: true, dynamicCount: dyn.length });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= STREAMED FORCED RELOAD ENDPOINT =====================
// GET /streamed/reload?token=XYZ&force=1
// Esegue streamed_channels.py una volta (opzionalmente con modalità force che ignora le finestre temporali)
app.get('/streamed/reload', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.STREAMED_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const force = 'force' in req.query && String(req.query.force).toLowerCase() !== '0';
        const scriptPath = path.join(__dirname, '..', 'streamed_channels.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(404).json({ ok: false, error: 'streamed_channels.py not found' });
        }
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const env: any = { ...process.env };
        try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
        if (force) env.STREAMED_FORCE = '1';
        const started = Date.now();
        const { execFile } = require('child_process');
        const execResult = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
            const child = execFile(pythonBin, [scriptPath, force ? '--force' : ''], { env }, (err: any, stdout: string, stderr: string) => {
                resolve({ stdout, stderr, code: err && typeof err.code === 'number' ? err.code : 0 });
            });
            child.on('error', (e: any) => {
                console.log('[STREAMED][RELOAD][ERR]', e?.message || e);
            });
        });
        // Ricarica dynamic in memoria se il file è stato modificato
        try { invalidateDynamicChannels(); loadDynamicChannels(true); } catch {}
        const took = Date.now() - started;
        const clip = (s: string) => s && s.length > 1200 ? s.slice(-1200) : s;
        return res.json({ ok: true, force, ms: took, stdout: clip(execResult.stdout), stderr: clip(execResult.stderr) });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= RBTV FORCED RELOAD ENDPOINT =====================
// GET /rbtv/reload?token=XYZ&force=1
// Esegue rbtv_streams.py una volta (opzionalmente con modalità force che ignora le finestre temporali)
app.get('/rbtv/reload', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.RBTV_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const force = 'force' in req.query && String(req.query.force).toLowerCase() !== '0';
        const scriptPath = path.join(__dirname, '..', 'rbtv_streams.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(404).json({ ok: false, error: 'rbtv_streams.py not found' });
        }
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const env: any = { ...process.env };
        try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
        if (force) env.RBTV_FORCE = '1';
        const started = Date.now();
        const { execFile } = require('child_process');
        const execResult = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
            const child = execFile(pythonBin, [scriptPath, force ? '--force' : ''], { env }, (err: any, stdout: string, stderr: string) => {
                resolve({ stdout, stderr, code: err && typeof err.code === 'number' ? err.code : 0 });
            });
            child.on('error', (e: any) => {
                console.log('[RBTV][RELOAD][ERR]', e?.message || e);
            });
        });
        // Ricarica dynamic in memoria se il file è stato modificato
        try { invalidateDynamicChannels(); loadDynamicChannels(true); } catch {}
        const took = Date.now() - started;
        const clip = (s: string) => s && s.length > 1200 ? s.slice(-1200) : s;
        return res.json({ ok: true, force, ms: took, stdout: clip(execResult.stdout), stderr: clip(execResult.stderr) });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= SPSO FORCED RELOAD ENDPOINT =====================
// GET /spso/reload?token=XYZ&force=1
// Esegue spso_streams.py una volta (modalità force opzionale)
app.get('/spso/reload', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.SPSO_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const force = 'force' in req.query && String(req.query.force).toLowerCase() !== '0';
        const scriptPath = path.join(__dirname, '..', 'spso_streams.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(404).json({ ok: false, error: 'spso_streams.py not found' });
        }
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const env: any = { ...process.env };
        try { env.DYNAMIC_FILE = getDynamicFilePath(); } catch {}
        if (force) env.SPSO_FORCE = '1';
        const started = Date.now();
        const { execFile } = require('child_process');
        const execResult = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
            const child = execFile(pythonBin, [scriptPath, force ? '--force' : ''], { env }, (err: any, stdout: string, stderr: string) => {
                resolve({ stdout, stderr, code: err && typeof err.code === 'number' ? err.code : 0 });
            });
            child.on('error', (e: any) => {
                console.log('[SPSO][RELOAD][ERR]', e?.message || e);
            });
        });
        try { invalidateDynamicChannels(); loadDynamicChannels(true); } catch {}
        const took = Date.now() - started;
        const clip = (s: string) => s && s.length > 1200 ? s.slice(-1200) : s;
        return res.json({ ok: true, force, ms: took, stdout: clip(execResult.stdout), stderr: clip(execResult.stderr) });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= MANUAL STATIC CHANNELS RELOAD ===============
// GET /static/reload?token=XYZ (token optional if STATIC_RELOAD_TOKEN set)
// Forza il ricaricamento di config/tv_channels.json (anche se mtime identico) e restituisce statistiche
app.get('/static/reload', (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.STATIC_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const beforeHash = _staticFileLastHash;
        const beforeMtime = _staticFileLastMtime;
        _loadStaticChannelsIfChanged(true); // forza reload
        const changed = (_staticFileLastHash !== beforeHash) || (_staticFileLastMtime !== beforeMtime);
        let pdCount = 0;
        for (const c of staticBaseChannels) if (c && (c as any).pdUrlF) pdCount++;
        const total = staticBaseChannels.length;
        console.log(`[TV][RELOAD][API] /static/reload changed=${changed} total=${total} pdUrlF=${pdCount} hash=${_staticFileLastHash.slice(0,12)}`);
        return res.json({
            ok: true,
            changed,
            total,
            pdUrlF: pdCount,
            mtime: _staticFileLastMtime ? new Date(_staticFileLastMtime).toISOString() : null,
            hash: _staticFileLastHash,
        });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= MANUAL PURGE ENDPOINT =====================
// Esegue la stessa logica delle 02:00: rimuove dal file gli eventi del giorno precedente
app.get('/live/purge', (req: Request, res: Response) => {
    try {
        const result = purgeOldDynamicEvents();
        // Ricarica cache in memoria
        loadDynamicChannels(true);
        res.json({ ok: true, ...result });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================
// ================================================================

// ================= RUNTIME TOGGLE FAST/EXTRACTOR ================
// /admin/mode?fast=1 abilita fast mode (diretto); ?fast=0 torna extractor
// Restituisce lo stato corrente. Non persiste su restart (solo runtime)
app.get('/admin/mode', (req: Request, res: Response) => {
    const q = (req.query.fast || '').toString().trim();
    if (q === '1' || q.toLowerCase() === 'true') {
        (process as any).env.FAST_DYNAMIC = '1';
    } else if (q === '0' || q.toLowerCase() === 'false') {
        (process as any).env.FAST_DYNAMIC = '0';
    }
    const fastDynamic = (process.env.FAST_DYNAMIC === '1' || process.env.FAST_DYNAMIC === 'true');
    res.json({ ok: true, fastDynamic });
});
// ================================================================

// Porta con auto-retry se occupata (fino a +10 tentativi)
function startServer(basePort: number, attempts = 0) {
    const PORT = basePort + attempts;
    const server = app.listen(PORT, () => {
        console.log(`Addon server running on http://127.0.0.1:${PORT}`);
    });
    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
            console.log(`⚠️ Porta ${PORT} occupata, provo con ${PORT + 1}...`);
            setTimeout(() => startServer(basePort, attempts + 1), 300);
        } else if (err.code === 'EADDRINUSE') {
            console.error(`❌ Nessuna porta libera trovata dopo ${attempts + 1} tentativi partendo da ${basePort}`);
        } else {
            console.error('❌ Errore server:', err);
        }
    });
}
const basePort = parseInt(process.env.PORT || '7860', 10);
startServer(basePort);

// ================= STARTUP AUTO-PURGE CHECK =====================
// Esegue un controllo una sola volta ~20s dopo l'avvio per:
//  - Forzare un loadDynamicChannels(true) (applicando il filtro runtime se abilitato)
//  - Loggare quanti eventi sono stati rimossi rispetto al file grezzo
//  - Evitare sorprese se l'utente non ha impostato variabili env (comportamento di default atteso)
setTimeout(() => {
    try {
        const dynPath = getDynamicFilePath();
        const beforeRaw = (() => {
            try {
                if (!dynPath || !fs.existsSync(dynPath)) return 0;
                const raw = JSON.parse(fs.readFileSync(dynPath,'utf-8'));
                return Array.isArray(raw) ? raw.length : 0;
            } catch { return 0; }
        })();
        // Forza reload applicando eventuale filtro runtime
        const filtered = loadDynamicChannels(true);
        const after = filtered.length;
        if (beforeRaw && after <= beforeRaw) {
            console.log(`[STARTUP][PURGE-CHECK] path=${dynPath} before=${beforeRaw} afterFilter=${after} removed=${beforeRaw-after}`);
        } else {
            console.log(`[STARTUP][PURGE-CHECK] path=${dynPath} count=${after} (no removals or file empty)`);
        }
    } catch (e: any) {
        console.log('[STARTUP][PURGE-CHECK][ERR]', e?.message || e);
    }
}, 20000);
// ================================================================

// Funzione per assicurarsi che le directory di cache esistano
function ensureCacheDirectories(): void {
    try {
        // Directory per la cache Vavoo
        const cacheDir = path.join(__dirname, '../cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            console.log(`📁 Directory cache creata: ${cacheDir}`);
        }
    } catch (error) {
        console.error('❌ Errore nella creazione delle directory di cache:', error);
    }
}

// Assicurati che le directory di cache esistano all'avvio
ensureCacheDirectories();

// ================== LIVE EVENTS SCHEDULER (Live.py) ==================
// Esegue Live.py OGNI 2 ORE a partire dalle 08:10 Europe/Rome (08:10, 10:10, 12:10, ... fino a 06:10).
// Lo script aggiorna config/dynamic_channels.json; dopo ogni run forziamo reload cache dinamica.

interface ScheduledRun {
    hour: number;
    minute: number;
}

const LIVE_SCRIPT_PATH = path.join(__dirname, '..', 'Live.py');
const LIVE_LOG_DIR = path.join(__dirname, '../logs');
const LIVE_LOG_FILE = path.join(LIVE_LOG_DIR, 'live_scheduler.log');
if (!fs.existsSync(LIVE_LOG_DIR)) {
    try { fs.mkdirSync(LIVE_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

const liveRuns: ScheduledRun[] = [
    { hour: 8,  minute: 10 }, // 08:10
    { hour: 10, minute: 10 }, // 10:10
    { hour: 12, minute: 10 }, // 12:10
    { hour: 14, minute: 10 }, // 14:10
    { hour: 16, minute: 10 }, // 16:10
    { hour: 18, minute: 10 }, // 18:10
    { hour: 20, minute: 10 }, // 20:10
    { hour: 22, minute: 10 }, // 22:10
    { hour: 0,  minute: 10 }, // 00:10
    { hour: 2,  minute: 10 }, // 02:10
    { hour: 4,  minute: 10 }, // 04:10
    { hour: 6,  minute: 10 }  // 06:10
];

function logLive(msg: string, ...extra: any[]) {
    const stamp = new Date().toISOString();
    const line = `${stamp} [LIVE] ${msg} ${extra.length ? JSON.stringify(extra) : ''}\n`;
    try { fs.appendFileSync(LIVE_LOG_FILE, line); } catch { /* ignore */ }
    console.log(line.trim());
}

function nowRome(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}

function computeDelayToNextRun(): number {
    const romeNow = nowRome();
    let nextDiff = Number.MAX_SAFE_INTEGER;
    for (const run of liveRuns) {
        const target = new Date(romeNow.getTime());
        target.setHours(run.hour, run.minute, 0, 0);
        let diff = target.getTime() - romeNow.getTime();
        if (diff < 0) diff += 24 * 60 * 60 * 1000; // giorno successivo
        if (diff < nextDiff) nextDiff = diff;
    }
    return nextDiff === Number.MAX_SAFE_INTEGER ? 60 * 60 * 1000 : nextDiff;
}

async function executeLiveScript(): Promise<{ stdout?: string; stderr?: string; error?: string }> {
    if (!fs.existsSync(LIVE_SCRIPT_PATH)) {
        logLive('Live.py non trovato, skip esecuzione');
        return { error: 'Live.py not found' };
    }
    logLive('Esecuzione Live.py avviata');
    try {
        const { execFile } = require('child_process');
        const result = await new Promise<{ stdout?: string; stderr?: string; error?: string }>((resolve) => {
            const child = execFile('python3', [LIVE_SCRIPT_PATH], {
                timeout: 1000 * 60 * 4,
                env: { ...process.env, DYNAMIC_FILE: '/tmp/dynamic_channels.json' }
            }, (err: any, stdout: string, stderr: string) => {
                if (stdout) logLive('Output Live.py', stdout.slice(0, 800));
                if (stderr) logLive('Stderr Live.py', stderr.slice(0, 800));
                if (err) logLive('Errore Live.py', err.message || err);
                resolve({ stdout, stderr, error: err ? (err.message || String(err)) : undefined });
            });
            // Safety: se child resta appeso oltre timeout integrato execFile lancerà errore
            child.on('error', (e: any) => logLive('Errore processo Live.py', e.message || e));
        });
        // Ricarica canali dinamici (force) e svuota cache tvChannels merge (ricarico solo dynamic parte)
        loadDynamicChannels(true);
        logLive('Reload canali dinamici completato dopo Live.py');
        return result;
    } catch (e: any) {
        logLive('Eccezione esecuzione Live.py', e?.message || String(e));
        return { error: e?.message || String(e) };
    }
}

function scheduleNextLiveRun() {
    const delay = computeDelayToNextRun();
    logLive('Prossima esecuzione Live.py tra ms', delay);
    setTimeout(async () => {
        await executeLiveScript();
        try {
            const r = purgeOldDynamicEvents();
            loadDynamicChannels(true);
            logLive('Purge post-run Live.py eseguito', r);
        } catch (e: any) {
            logLive('Errore purge post-run Live.py', e?.message || String(e));
        }
        scheduleNextLiveRun();
    }, delay);
}

// Avvia scheduler dopo avvio server (dopo breve delay per evitare conflitto startup)
setTimeout(() => {
    logLive('Scheduler Live eventi attivato');
    scheduleNextLiveRun();
}, 5000);
// ====================================================================

// ================== AUTO PURGE SCHEDULER ============================
function computeDelayToNextPurge(): number {
    const romeNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const target = new Date(romeNow.getTime());
    target.setHours(2, 5, 0, 0); // 02:05 Rome
    let diff = target.getTime() - romeNow.getTime();
    if (diff < 0) diff += 24 * 60 * 60 * 1000; // domani
    return diff;
}

function scheduleNextAutoPurge() {
    const delay = computeDelayToNextPurge();
    console.log(`🗓️ Prossimo purge automatico alle 02:05 Rome tra ms: ${delay}`);
    setTimeout(() => {
        try {
            const result = purgeOldDynamicEvents();
            loadDynamicChannels(true);
            console.log(`🧹 Purge automatico eseguito: removed=${result.removed} after=${result.after}`);
        } catch (e) {
            console.error('❌ Errore purge automatico:', e);
        } finally {
            scheduleNextAutoPurge();
        }
    }, delay);
}

// Avvia scheduling purge dopo avvio server (leggero delay per startup)
setTimeout(() => scheduleNextAutoPurge(), 7000);
// ====================================================================

// =============== WATCHER dynamic_channels.json =======================
try {
    const dynamicFilePath = path.join(__dirname, '../config/dynamic_channels.json');
    if (fs.existsSync(dynamicFilePath)) {
    fs.watch(dynamicFilePath, { persistent: false }, (evt: any) => {
            if (evt === 'change') {
                console.log('🔄 Detected change in dynamic_channels.json -> invalidate & reload');
                invalidateDynamicChannels();
                loadDynamicChannels(true);
            }
        });
        console.log('👁️  Watch attivo su dynamic_channels.json');
    }
} catch (e) {
    console.error('❌ Impossibile attivare watcher dynamic_channels.json:', e);
}
// ====================================================================

// =============== DAILY 02:30 ROME RELOAD =============================
function computeDelayToDailyReload(): number {
    const romeNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const target = new Date(romeNow.getTime());
    target.setHours(2, 30, 0, 0); // 02:30 Rome
    let diff = target.getTime() - romeNow.getTime();
    if (diff < 0) diff += 24 * 60 * 60 * 1000;
    return diff;
}
function scheduleDailyReload() {
    const delay = computeDelayToDailyReload();
    console.log(`🗓️ Prossimo reload dinamici alle 02:30 Rome tra ms: ${delay}`);
    setTimeout(() => {
        try {
            invalidateDynamicChannels();
            const dyn = loadDynamicChannels(true);
            console.log(`🔁 Reload automatico 02:30 completato: dynamicCount=${dyn.length}`);
        } catch (e) {
            console.error('❌ Errore reload automatico 02:30:', e);
        } finally {
            scheduleDailyReload();
        }
    }, delay);
}
setTimeout(() => scheduleDailyReload(), 9000);
// ====================================================================
