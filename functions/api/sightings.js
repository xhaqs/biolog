const DB = 'https://riakoine-fauna-default-rtdb.asia-southeast1.firebasedatabase.app';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
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
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

export async function onRequestGet(context) {
  try {
    const r = await fetch(DB + '/fauna/sightings.json');
    const data = await r.json();
    return new Response(JSON.stringify(data || {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
