/**
 * EchoField TTS — Cloudflare Worker Proxy  v5
 * Routes:
 *   POST /           → TTS generation (returns audio/mpeg)
 *   POST /sing       → ElevenLabs singing via eleven_v3 (returns audio/mpeg)
 *   GET  /voices     → List your EL voices (returns JSON)
 *   POST /voices/add → Clone a voice from uploaded audio (returns JSON)
 *   POST /feedback   → Submit beta feedback → Airtable
 *
 * Worker env vars (Settings → Variables → Secrets):
 *   ELEVENLABS_API_KEY  (Secret)   your EL API key
 *   VOICE_ID            (Text)     default voice ID for TTS
 *   ALLOWED_ORIGIN      (Text)     e.g. https://echofield.pages.dev
 *   AIRTABLE_BASE_ID    (Text)     e.g. appXXXXXXXXXXXXXX
 *   AIRTABLE_API_KEY    (Secret)   your Airtable personal access token
 *   RATE_LIMIT_KV       (KV)       optional KV namespace for rate limiting
 */

const RATE_LIMIT    = 20;
const EL_MODEL_TTS  = 'eleven_multilingual_v2';
const EL_MODEL_SING = 'eleven_v3';           // singing model
const EL_BASE       = 'https://api.elevenlabs.io/v1';
const AT_TABLE      = 'Responses';

const ALLOWED_AUDIO_TYPES = ['audio/mpeg','audio/mp3','audio/mp4','audio/m4a',
  'audio/wav','audio/wave','audio/x-wav','audio/webm','audio/ogg','audio/flac'];

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── GET /voices ───────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/voices') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not set' }, 500, cors);
      const r = await fetch(`${EL_BASE}/voices`, {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      });
      const data = await r.json().catch(() => ({}));
      return json(data, r.status, cors);
    }

    // ── POST /voices/add ──────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/voices/add') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not set' }, 500, cors);

      let incoming;
      try { incoming = await request.formData(); }
      catch (e) { return json({ error: 'FormData parse error: ' + e.message }, 400, cors); }

      const fd = new FormData();
      for (const [key, value] of incoming.entries()) {
        if (value instanceof File || value instanceof Blob) {
          const rawType = (value.type || '').split(';')[0].trim().toLowerCase();
          const mimeType = ALLOWED_AUDIO_TYPES.includes(rawType) ? rawType : 'audio/mpeg';
          const filename  = (value instanceof File && value.name) ? value.name
            : `sample.${mimeType.split('/')[1] || 'mp3'}`;
          const bytes = await value.arrayBuffer();
          fd.append(key, new Blob([bytes], { type: mimeType }), filename);
        } else {
          fd.append(key, value);
        }
      }

      const r = await fetch(`${EL_BASE}/voices/add`, {
        method:  'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
        body: fd,
      });
      const rawText = await r.text().catch(() => '{}');
      let data;
      try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }
      if (!r.ok) return json({
        error: data?.detail?.message || data?.detail || data?.error || rawText.slice(0, 300),
        status: r.status,
      }, r.status, cors);
      return json(data, r.status, cors);
    }

    // ── POST /feedback → Airtable ─────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/feedback') {
      if (!env.AIRTABLE_API_KEY) return json({ error: 'AIRTABLE_API_KEY not set' }, 500, cors);
      if (!env.AIRTABLE_BASE_ID) return json({ error: 'AIRTABLE_BASE_ID not set' }, 500, cors);

      let body;
      try { body = await request.json(); }
      catch (e) { return json({ error: 'Invalid JSON body' }, 400, cors); }

      body['Submitted At'] = new Date().toISOString();
      const atRes = await fetch(
        `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(AT_TABLE)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ fields: body }),
        }
      );
      const atData = await atRes.json().catch(() => ({}));
      return json(atData, atRes.ok ? 200 : 500, cors);
    }

    // ── POST /sing — ElevenLabs singing (eleven_v3) ───────────────
    if (request.method === 'POST' && url.pathname === '/sing') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not set' }, 500, cors);

      // Rate limit
      if (env.RATE_LIMIT_KV) {
        const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
        const key = `rl:sing:${ip}:${Math.floor(Date.now() / 60000)}`;
        const cur = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
        if (cur >= RATE_LIMIT) return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, cors);
        await env.RATE_LIMIT_KV.put(key, String(cur + 1), { expirationTtl: 120 });
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'Invalid JSON body' }, 400, cors); }

      let text    = (body.text || '').trim();
      const voiceId = body.voice_id || env.VOICE_ID || '';

      if (!text)    return json({ error: 'text is required' }, 400, cors);
      if (!voiceId) return json({ error: 'No voice_id' }, 500, cors);

      // Auto-wrap in [singing] tags if the user hasn't already
      if (!text.includes('[singing]')) {
        text = `[singing] ${text}`;
      }

      const elResp = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
        method:  'POST',
        headers: {
          'xi-api-key':   env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: EL_MODEL_SING,
          voice_settings: body.voice_settings || {
            stability: 0.45, similarity_boost: 0.85, style: 0.30, use_speaker_boost: true,
          },
        }),
      });

      if (!elResp.ok) {
        const errText = await elResp.text().catch(() => '');
        return json({ error: `EL sing ${elResp.status}: ${errText.slice(0, 300)}` }, elResp.status, cors);
      }

      return new Response(elResp.body, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
      });
    }

    // ── POST / — TTS generation ───────────────────────────────────
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);

    if (env.RATE_LIMIT_KV) {
      const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
      const cur = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
      if (cur >= RATE_LIMIT) return json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, cors);
      await env.RATE_LIMIT_KV.put(key, String(cur + 1), { expirationTtl: 120 });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400, cors); }

    const text    = (body.text || '').trim();
    const voiceId = body.voice_id || env.VOICE_ID || '';

    if (!text)                   return json({ error: 'text is required' }, 400, cors);
    if (!voiceId)                return json({ error: 'No voice_id' }, 500, cors);
    if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not set' }, 500, cors);

    const elResp = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
      method:  'POST',
      headers: {
        'xi-api-key':   env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text, model_id: EL_MODEL_TTS,
        voice_settings: body.voice_settings || {
          stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true,
        },
      }),
    });

    if (!elResp.ok) {
      const errText = await elResp.text().catch(() => '');
      return json({ error: `EL ${elResp.status}: ${errText.slice(0, 300)}` }, elResp.status, cors);
    }

    return new Response(elResp.body, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  },
};

function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}
