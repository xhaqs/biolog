const DB = 'https://riakoine-fauna-default-rtdb.asia-southeast1.firebasedatabase.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/rangecheck') {
      return handleRangeCheck(url);
    }

    if (url.pathname === '/api/identify' && request.method === 'POST') {
      return handleIdentify(request, env);
    }
    if (url.pathname === '/api/sightings') {
      return handleSightings(request, env);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const newResponse = new Response(assetResponse.body, assetResponse);
    newResponse.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.firebasedatabase.app https://api.anthropic.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org; media-src 'self' data: blob:; base-uri 'self'");
    return newResponse;
  }
};

async function handleRangeCheck(url) {
  try {
    const species = url.searchParams.get('species');
    const lat = parseFloat(url.searchParams.get('lat'));
    const lng = parseFloat(url.searchParams.get('lng'));

    if (!species || isNaN(lat) || isNaN(lng)) {
      return new Response(JSON.stringify({ notable: false }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const matchRes = await fetch('https://api.gbif.org/v1/species/match?name=' + encodeURIComponent(species));
    const matchData = await matchRes.json();
    const taxonKey = matchData.usageKey;

    if (!taxonKey) {
      return new Response(JSON.stringify({ notable: false }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    const box = 2.0;
    const nearbyUrl = 'https://api.gbif.org/v1/occurrence/search?taxonKey=' + taxonKey
      + '&decimalLatitude=' + (lat - box) + ',' + (lat + box)
      + '&decimalLongitude=' + (lng - box) + ',' + (lng + box)
      + '&limit=1';
    const nearbyRes = await fetch(nearbyUrl);
    const nearbyData = await nearbyRes.json();
    const nearbyCount = nearbyData.count || 0;

    const globalUrl = 'https://api.gbif.org/v1/occurrence/search?taxonKey=' + taxonKey + '&limit=1';
    const globalRes = await fetch(globalUrl);
    const globalData = await globalRes.json();
    const globalCount = globalData.count || 0;

    const notable = globalCount > 20 && nearbyCount === 0;

    return new Response(JSON.stringify({ notable, nearbyCount, globalCount }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ notable: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleIdentify(request, env) {
  try {
    const body = await request.json();
    const { image, mediaType, lat, lng } = body;

    if (!image || !mediaType) {
      return new Response(JSON.stringify({ error: 'image and mediaType required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const promptText = 'Identify the plant or animal species in this image.'
      + (lat && lng ? ' The photo was taken near latitude ' + lat + ', longitude ' + lng + ' — use this to infer the region and give the local/vernacular name in whatever language is predominant there.' : '')
      + ' Reply ONLY in valid JSON, no markdown, no preamble, in this exact format: {"name":"English common name","latin":"Scientific name","local_name":"Local/vernacular name in the predominant regional language if known, otherwise empty string","local_language":"name of that language, e.g. Swahili, Spanish, Hindi, otherwise empty string","kingdom":"flora or fauna","description":"2-sentence natural history note: habitat, behavior, or identifying features","confidence":"high, medium, or low"}';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: promptText }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'Anthropic API error' }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const text = data.content?.[0]?.text || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { name: 'Unidentified specimen', latin: '', kingdom: 'fauna', description: text.slice(0, 150), confidence: 'low' };
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleSightings(request, env) {
  try {
    if (request.method === 'POST') {
      const body = await request.json();
      const r = await fetch(DB + '/fauna/sightings.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    if (request.method === 'GET') {
      const r = await fetch(DB + '/fauna/sightings.json');
      const data = await r.json();
      return new Response(JSON.stringify(data || {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
