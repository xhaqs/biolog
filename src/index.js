const DB = 'https://riakoine-fauna-default-rtdb.asia-southeast1.firebasedatabase.app';

const DAILY_IDENTIFY_LIMIT = 20; // generous for legitimate field use, catches abuse

/**
 * Basic per-IP daily rate limit for the /api/identify endpoint specifically,
 * since it's the one that calls Claude's vision API and incurs real cost per
 * request. Uses the existing Firebase database rather than requiring a new
 * KV namespace. Returns a 429 Response if the limit is exceeded, or null to
 * allow the request through.
 */
const LIFETIME_ID_CAP = 1000; // matches the "Founder's Access - 1,000 lifetime identifications" offer

/**
 * Enforces the 1,000-lifetime-identification cap tied to each purchased
 * license key (not just per-IP daily limits). Uses the existing Firebase
 * database. The owner bypass code is exempt so testing isn't capped.
 */
async function checkLifetimeCap(request, env) {
  try {
    const body = await request.clone().json();
    const licenseKey = (body.licenseKey || '').trim();

    if (!licenseKey) {
      // No license key provided - let the normal license gate handle this;
      // don't block here on a missing key specifically
      return null;
    }

    if (licenseKey === env.OWNER_BYPASS_CODE) {
      return null; // owner testing is unlimited
    }

    const safeKey = licenseKey.replace(/[.:#$\[\]]/g, '_');
    const path = '/fauna/lifetime_usage/' + safeKey + '.json';

    const getRes = await fetch(DB + path);
    const currentCount = (await getRes.json()) || 0;

    if (currentCount >= LIFETIME_ID_CAP) {
      return new Response(JSON.stringify({
        error: 'You have used all ' + LIFETIME_ID_CAP + ' identifications included with your Founder\'s Access. Contact support if you need more.'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await fetch(DB + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentCount + 1)
    });

    return null;
  } catch (e) {
    // Fail open - don't block legitimate use over an infrastructure hiccup
    return null;
  }
}

async function checkRateLimit(request) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const safeIp = ip.replace(/[.:#$\[\]]/g, '_');
    const today = new Date().toISOString().slice(0, 10);
    const path = '/fauna/ratelimits/' + safeIp + '/' + today + '.json';

    const getRes = await fetch(DB + path);
    const currentCount = (await getRes.json()) || 0;

    if (currentCount >= DAILY_IDENTIFY_LIMIT) {
      return new Response(JSON.stringify({
        error: 'Daily identification limit reached for this connection. This resets tomorrow - thanks for using Biolog responsibly.'
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await fetch(DB + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentCount + 1)
    });

    return null; // allow the request through
  } catch (e) {
    // If the rate limit check itself fails, fail open rather than blocking
    // legitimate use over an infrastructure hiccup
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Verify a Payhip license key (from a real purchase) to gate access to
    // the app. Uses Payhip's v2 license API with a product secret key kept
    // server-side, never exposed to the client.
    if (url.pathname === '/api/verify-license' && request.method === 'POST') {
      try {
        const body = await request.json();
        const licenseKey = (body.licenseKey || '').trim();
        if (!licenseKey) {
          return new Response(JSON.stringify({ valid: false, error: 'No license key provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Owner bypass - lets Phoenix test the app freely without needing a
        // real Payhip purchase each time. Checked server-side only.
        if (licenseKey === env.OWNER_BYPASS_CODE) {
          return new Response(JSON.stringify({ valid: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const payhipRes = await fetch(
          'https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(licenseKey),
          { headers: { 'product-secret-key': env.PAYHIP_PRODUCT_SECRET_KEY } }
        );
        if (!payhipRes.ok) {
          return new Response(JSON.stringify({ valid: false, error: 'Invalid license key' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const data = await payhipRes.json();
        const enabled = data?.data?.enabled === true;
        return new Response(JSON.stringify({ valid: enabled }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ valid: false, error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    if (url.pathname === '/api/rangecheck') {
      return handleRangeCheck(url);
    }

    if (url.pathname === '/api/identify' && request.method === 'POST') {
      const rateLimitResponse = await checkRateLimit(request);
      if (rateLimitResponse) return rateLimitResponse;
      const lifetimeCapResponse = await checkLifetimeCap(request, env);
      if (lifetimeCapResponse) return lifetimeCapResponse;
      return handleIdentify(request, env);
    }
    if (url.pathname === '/api/sightings') {
      return handleSightings(request, env);
    }

    // Fetch a single shared sighting by its Firebase key - used when someone
    // opens a shared link (?sighting=firebaseKey) so they see the actual
    // record even though it wasn't captured on their own device.
    if (url.pathname === '/api/sighting' && request.method === 'GET') {
      const sightingKey = url.searchParams.get('id');
      if (!sightingKey) {
        return new Response(JSON.stringify({ error: 'Missing id parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      try {
        const r = await fetch(DB + '/fauna/sightings/' + encodeURIComponent(sightingKey) + '.json');
        const data = await r.json();
        if (!data) {
          return new Response(JSON.stringify({ error: 'Sighting not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
          });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
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

async function getWeather(lat, lng, env) {
  if (!lat || !lng || !env.OPENWEATHER_API_KEY) return null;
  try {
    const r = await fetch('https://api.openweathermap.org/data/2.5/weather?lat='+lat+'&lon='+lng+'&appid='+env.OPENWEATHER_API_KEY+'&units=metric');
    if (!r.ok) return null;
    const d = await r.json();
    return {
      temp: d.main?.temp,
      condition: d.weather?.[0]?.description || '',
      humidity: d.main?.humidity
    };
  } catch (e) {
    return null;
  }
}

async function handleIdentify(request, env) {
  try {
    const body = await request.json();
    const { image, mediaType, images, lat, lng } = body;

    let imageList = [];
    if (images && Array.isArray(images)) {
      imageList = images;
    } else if (image && mediaType) {
      imageList = [{ image, mediaType }];
    }

    if (!imageList.length) {
      return new Response(JSON.stringify({ error: 'image(s) required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const promptText = 'Identify the plant(s) and/or animal(s) shown in ' + (imageList.length > 1 ? 'these '+imageList.length+' photos (different angles of the same scene — use all of them together for a more confident identification).' : 'this image.')
      + ' IMPORTANT: if there are multiple DISTINCT species visible (e.g. several different fruits, plants, or animals in the same shot), identify EACH ONE separately - do not merge them into a single generic answer.'
      + ' Also examine the visual background/surroundings in the photo to infer the immediate habitat context (this applies to the overall scene, shared across all species found).'
      + ' Reply ONLY in valid JSON, no markdown, no preamble, in this exact format: {"habitat_context":"brief inferred habitat from the photo background, e.g. near water, degraded forest, urban edge, grassland, wetland, forest canopy, rocky outcrop, garden/cultivated - your best guess from visual cues, shared across the whole scene","species":[{"name":"English common name","latin":"Scientific name","kingdom":"flora or fauna","description":"2-sentence natural history note: habitat, behavior, or identifying features","confidence":"high, medium, or low","invasive_risk":"high, medium, low, or unknown - whether this species is considered invasive in the given region","invasive_note":"1-sentence explanation if invasive_risk is high or medium, otherwise empty string","indicator_species":"yes or no - whether this species is a recognized bioindicator of ecosystem health (clean water, air quality, undisturbed habitat, etc)","indicator_note":"1-sentence explanation if indicator_species is yes, otherwise empty string"}]}'
      + ' The "species" field MUST be an array - even if there is only one specimen, wrap it in an array with one item.';

    const contentBlocks = imageList.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.image }
    }));
    contentBlocks.push({ type: 'text', text: promptText });

    const [response, weather] = await Promise.all([
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: contentBlocks
          }]
        })
      }),
      getWeather(lat, lng, env)
    ]);

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
      if (!Array.isArray(parsed.species)) {
        // Defensive: if the model didn't wrap in an array as instructed,
        // treat the whole object as a single species entry
        parsed = { habitat_context: parsed.habitat_context || '', species: [parsed] };
      }
    } catch (e) {
      parsed = { habitat_context: '', species: [{ name: 'Unidentified specimen', latin: '', kingdom: 'fauna', description: text.slice(0, 150), confidence: 'low' }] };
    }

    // Weather is shared across the whole scene, not per-species
    if (weather) {
      parsed.weather_temp = weather.temp;
      parsed.weather_condition = weather.condition;
      parsed.weather_humidity = weather.humidity;
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
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
