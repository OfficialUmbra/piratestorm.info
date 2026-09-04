function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const token = getCookie(request, "ps_session");

  if (!token) return null;

  return await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(token, Math.floor(Date.now() / 1000))
    .first();
}

function getServerCode(server) {
  const servers = {
    "Deutschland 1": "DE1",
    "Europa 1": "EU1",
    "Europa 2": "EU2",
    "Europa 3": "EU3",
    "Europa 4": "EU4",
    "Arabien 1": "AR1",
    "Lateinamerika 1": "LA1",
    "USA 1": "USA1"
  };

  return servers[server] || server;
}

async function findUser(env, id) {
  return await env.DB.prepare(`
    SELECT id, username, server, role
    FROM users
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

/*
 * GET
 *
 * Zeigt ausschließlich die eigene Blockierliste.
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    const result = await env.DB.prepare(`
      SELECT
        b.id,
        b.blocked_id,
        b.created_at,

        u.username,
        u.server,
        u.role

      FROM chat_blocks b

      JOIN users u
        ON u.id = b.blocked_id

      WHERE b.blocker_id = ?

      ORDER BY
        LOWER(u.username) ASC
    `)
      .bind(user.id)
      .all();

    const blocks = (result.results || []).map(item => ({
      id: item.id,

      user: {
        id: item.blocked_id,
        username: item.username,
        server: item.server,
        server_code: getServerCode(item.server),
        role: item.role
      },

      created_at: item.created_at
    }));

    return json({
      ok: true,
      blocks
    });
  } catch (error) {
    console.error("GET /api/chat/blocks error:", error);

    return json({
      ok: false,
      error: "Die Blockierliste konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * POST
 *
 * Blockiert einen Spieler.
 *
 * Erwartet:
 * {
 *   "user_id": 123
 * }
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Ungültige Anfrage."
      }, 400);
    }

    const blockedUserId = Number(body.user_id);

    if (
      !Number.isInteger(blockedUserId) ||
      blockedUserId <= 0
    ) {
      return json({
        ok: false,
        error: "Ungültiger Spieler."
      }, 400);
    }

    if (blockedUserId === user.id) {
      return json({
        ok: false,
        error: "Du kannst dich nicht selbst blockieren."
      }, 400);
    }

    const blockedUser = await findUser(
      env,
      blockedUserId
    );

    if (!blockedUser) {
      return json({
        ok: false,
        error: "Spieler wurde nicht gefunden."
      }, 404);
    }

    /*
     * Umbra/Admin soll für seine Moderation weiterhin
     * erreichbar bleiben.
     *
     * Deshalb kann ein normaler Nutzer den Admin nicht
     * persönlich blockieren.
     */
    if (blockedUser.role === "admin") {
      return json({
        ok: false,
        error: "Der Administrator kann nicht blockiert werden."
      }, 403);
    }

    const existing = await env.DB.prepare(`
      SELECT id
      FROM chat_blocks
      WHERE blocker_id = ?
        AND blocked_id = ?
      LIMIT 1
    `)
      .bind(user.id, blockedUserId)
      .first();

    if (existing) {
      return json({
        ok: true,
        already_blocked: true,
        message: "Dieser Spieler ist bereits blockiert."
      });
    }

    const now = Math.floor(Date.now() / 1000);

    const result = await env.DB.prepare(`
      INSERT INTO chat_blocks (
        blocker_id,
        blocked_id,
        created_at
      )
      VALUES (?, ?, ?)
    `)
      .bind(
        user.id,
        blockedUserId,
        now
      )
      .run();

    return json({
      ok: true,

      block: {
        id: result.meta.last_row_id,

        user: {
          id: blockedUser.id,
          username: blockedUser.username,
          server: blockedUser.server,
          server_code: getServerCode(
            blockedUser.server
          )
        },

        created_at: now
      },

      message:
        `${blockedUser.username} wurde blockiert.`
    }, 201);
  } catch (error) {
    console.error("POST /api/chat/blocks error:", error);

    return json({
      ok: false,
      error: "Der Spieler konnte nicht blockiert werden."
    }, 500);
  }
}

/*
 * DELETE
 *
 * Hebt eine eigene Blockierung auf.
 *
 * Aufruf:
 * DELETE /api/chat/blocks?user_id=123
 */
export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    const url = new URL(request.url);

    const blockedUserId = Number(
      url.searchParams.get("user_id")
    );

    if (
      !Number.isInteger(blockedUserId) ||
      blockedUserId <= 0
    ) {
      return json({
        ok: false,
        error: "Ungültiger Spieler."
      }, 400);
    }

    const existing = await env.DB.prepare(`
      SELECT
        b.id,
        u.username
      FROM chat_blocks b
      JOIN users u
        ON u.id = b.blocked_id
      WHERE b.blocker_id = ?
        AND b.blocked_id = ?
      LIMIT 1
    `)
      .bind(
        user.id,
        blockedUserId
      )
      .first();

    if (!existing) {
      return json({
        ok: false,
        error: "Dieser Spieler ist nicht blockiert."
      }, 404);
    }

    await env.DB.prepare(`
      DELETE FROM chat_blocks
      WHERE blocker_id = ?
        AND blocked_id = ?
    `)
      .bind(
        user.id,
        blockedUserId
      )
      .run();

    return json({
      ok: true,
      message:
        `${existing.username} wurde entsperrt.`
    });
  } catch (error) {
    console.error("DELETE /api/chat/blocks error:", error);

    return json({
      ok: false,
      error: "Die Blockierung konnte nicht aufgehoben werden."
    }, 500);
  }
}
