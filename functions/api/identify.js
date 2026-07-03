export async function onRequestPost(context) {
  const { request, env } = context;

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
