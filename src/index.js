/**
 * Worker entry point.
 *
 * Two jobs: serve the static client, and hand real requests to the right
 * lobby's Durable Object. Everything cheap and rejectable happens *here* —
 * both Workers and Durable Objects are billed per request, so a malformed
 * room code must never be allowed to instantiate an empty DO.
 */

import { Lobby } from './server/lobby.js';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, sanitizeName } from './shared/codes.js';
import { GAMES } from './games/index.js';

export { Lobby };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

/** Resolve a room code to its lobby stub. Deterministic: same code, same object. */
function lobbyFor(env, code) {
  return env.LOBBY.get(env.LOBBY.idFromName(code));
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ---- game manifest ------------------------------------------------------
    // Static, so it can be cached hard. Includes the rules text so the in-game
    // "how to play" sheet works with no extra round trip.
    if (pathname === '/api/games' && request.method === 'GET') {
      return new Response(
        JSON.stringify(
          Object.values(GAMES).map((g) => ({ ...g.meta, rules: g.rulesText, defaults: g.defaultConfig })),
        ),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        },
      );
    }

    // ---- create a lobby -----------------------------------------------------
    if (pathname === '/api/create' && request.method === 'POST') {
      const body = await readJson(request);
      const gameId = String(body.game ?? '');
      if (!Object.hasOwn(GAMES, gameId)) return json({ error: 'unknown_game' }, 400);

      const name = sanitizeName(body.name);
      if (!name) return json({ error: 'name_required' }, 400);

      // A Durable Object is single-threaded, so claim() is a genuine
      // compare-and-set. There is no "does this object exist?" API, so the
      // round trip *is* the existence check.
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = generateRoomCode();
        const seat = await lobbyFor(env, code).claim(code, gameId, name);
        if (seat) return json({ code, game: gameId, ...seat });
      }
      return json({ error: 'no_free_code' }, 503);
    }

    // ---- join a lobby -------------------------------------------------------
    if (pathname === '/api/join' && request.method === 'POST') {
      const body = await readJson(request);
      const code = normalizeRoomCode(body.code);
      if (!isValidRoomCode(code)) return json({ error: 'bad_code' }, 400);

      const name = sanitizeName(body.name);
      if (!name) return json({ error: 'name_required' }, 400);

      const result = await lobbyFor(env, code).join(name);
      if (result.error) return json(result, result.error === 'not_found' ? 404 : 409);
      return json({ code, ...result });
    }

    // ---- peek at a lobby (used by the join screen to confirm the room) ------
    if (pathname === '/api/room' && request.method === 'GET') {
      const code = normalizeRoomCode(url.searchParams.get('code'));
      if (!isValidRoomCode(code)) return json({ error: 'bad_code' }, 400);
      const info = await lobbyFor(env, code).peek();
      return info ? json({ code, ...info }) : json({ error: 'not_found' }, 404);
    }

    // ---- websocket ----------------------------------------------------------
    if (pathname === '/ws') {
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return new Response('expected Upgrade: websocket', { status: 426 });
      }
      const code = normalizeRoomCode(url.searchParams.get('code'));
      if (!isValidRoomCode(code)) return new Response('bad code', { status: 400 });
      return lobbyFor(env, code).fetch(request);
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);

    // Everything else is the static client. `/JOIN/ABCD` and `/tv/ABCD` are
    // client-side routes, resolved by the SPA fallback.
    return env.ASSETS.fetch(request);
  },
};
