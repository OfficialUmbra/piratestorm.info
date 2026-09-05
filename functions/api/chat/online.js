const ONLINE_TIMEOUT_SECONDS = 10 * 60;

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
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(token, Math.floor(Date.now() / 1000))
    .first();
}

function isAdmin(user) {
  return Boolean(user && user.role === "admin");
}

async function cleanupExpiredPresence(env) {
  const cutoff =
    Math.floor(Date.now() / 1000) -
    ONLINE_TIMEOUT_SECONDS;

  await env.DB.prepare(`
    DELETE FROM chat_presence
    WHERE last_seen < ?
  `)
    .bind(cutoff)
    .run();
}

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

    await cleanupExpiredPresence(env);

    const url = new URL(request.url);

    const room =
      (url.searchParams.get("room") || "global")
        .toLowerCase();

    if (room !== "global" && room !== "server") {
      return json({
        ok: false,
        error: "Ungültiger Chatraum."
      }, 400);
    }

    const cutoff =
      Math.floor(Date.now() / 1000) -
      ONLINE_TIMEOUT_SECONDS;

    let result;
    let activeServer = null;

    if (room === "global") {
      result = await env.DB.prepare(`
        SELECT
          u.id,
          u.username,
          u.server,
          u.role,
          p.last_seen
        FROM chat_presence p
        JOIN users u ON u.id = p.user_id
        WHERE p.last_seen >= ?
          AND p.room_type = 'global'
        ORDER BY
          CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
          LOWER(u.username) ASC
      `)
        .bind(cutoff)
        .all();
    } else {
      activeServer =
        isAdmin(user)
          ? (url.searchParams.get("server") || user.server)
          : user.server;

      result = await env.DB.prepare(`
        SELECT
          u.id,
          u.username,
          u.server,
          u.role,
          p.last_seen
        FROM chat_presence p
        JOIN users u ON u.id = p.user_id
        WHERE p.last_seen >= ?
          AND p.room_type = 'server'
          AND p.server = ?
        ORDER BY
          CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
          LOWER(u.username) ASC
      `)
        .bind(cutoff, activeServer)
        .all();
    }

    const players = (result.results || []).map(player => ({
      id: player.id,
      username: player.username,
      server: player.server,
      role: player.role,
      is_admin: player.role === "admin",
      last_seen: player.last_seen
    }));

    return json({
      ok: true,
      room,
      server: activeServer,
      online_timeout_seconds: ONLINE_TIMEOUT_SECONDS,
      count: players.length,
      players
    });

  } catch (error) {
    console.error("GET /api/chat/online error:", error);

    return json({
      ok: false,
      error: "Die Online-Liste konnte nicht geladen werden."
    }, 500);
  }
}

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

    const room =
      typeof body.room === "string"
        ? body.room.toLowerCase()
        : "";

    if (room !== "global" && room !== "server") {
      return json({
        ok: false,
        error: "Ungültiger Chatraum."
      }, 400);
    }

    let server = null;

    if (room === "server") {
      server =
        isAdmin(user)
          ? (
              typeof body.server === "string" &&
              body.server.trim()
                ? body.server.trim()
                : user.server
            )
          : user.server;
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO chat_presence (
        user_id,
        last_seen,
        room_type,
        server
      )
      VALUES (?, ?, ?, ?)

      ON CONFLICT(user_id)
      DO UPDATE SET
        last_seen = excluded.last_seen,
        room_type = excluded.room_type,
        server = excluded.server
    `)
      .bind(user.id, now, room, server)
      .run();

    return json({
      ok: true,
      online: true,
      user: {
        id: user.id,
        username: user.username,
        server: user.server,
        role: user.role,
        is_admin: isAdmin(user)
      },
      room,
      active_server: server,
      last_seen: now,
      expires_after_seconds: ONLINE_TIMEOUT_SECONDS
    });

  } catch (error) {
    console.error("POST /api/chat/online error:", error);

    return json({
      ok: false,
      error: "Der Online-Status konnte nicht aktualisiert werden."
    }, 500);
  }
}

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

    await env.DB.prepare(`
      DELETE FROM chat_presence
      WHERE user_id = ?
    `)
      .bind(user.id)
      .run();

    return json({
      ok: true,
      online: false
    });

  } catch (error) {
    console.error("DELETE /api/chat/online error:", error);

    return json({
      ok: false,
      error: "Der Online-Status konnte nicht entfernt werden."
    }, 500);
  }
}
