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

  if (!token) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role
    FROM sessions
    JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(
      token,
      Math.floor(Date.now() / 1000)
    )
    .first();
}

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
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

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Lädt die Online-Spielerliste.
 *
 * Global:
 * /api/chat/online?room=global
 *
 * Server:
 * /api/chat/online?room=server
 *
 * Admin kann optional:
 * /api/chat/online?room=server&server=Europa%201
 *
 * Normale Spieler können ausschließlich ihren
 * eigenen Server sehen.
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    await cleanupExpiredPresence(env);

    const url =
      new URL(request.url);

    const room =
      (
        url.searchParams.get("room") ||
        "global"
      ).toLowerCase();

    if (
      room !== "global" &&
      room !== "server"
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Chatraum."
      }, 400);
    }

    const cutoff =
      Math.floor(Date.now() / 1000) -
      ONLINE_TIMEOUT_SECONDS;

    let result;

    /*
     * =============================================
     * GLOBALCHAT
     * =============================================
     *
     * Jeder eingeloggte Spieler darf sehen,
     * welche Spieler derzeit im Globalchat
     * aktiv sind.
     */
    if (room === "global") {
      result =
        await env.DB.prepare(`
          SELECT
            u.id,
            u.username,
            u.server,
            u.role,
            p.last_seen,
            p.room_type,
            p.server AS presence_server

          FROM chat_presence p

          JOIN users u
            ON u.id = p.user_id

          WHERE p.last_seen >= ?
            AND p.room_type = 'global'

          ORDER BY
            CASE
              WHEN u.role = 'admin'
              THEN 0
              ELSE 1
            END,
            LOWER(u.username) ASC
        `)
          .bind(cutoff)
          .all();
    }

    /*
     * =============================================
     * SERVERCHAT
     * =============================================
     */
    else {
      let requestedServer =
        url.searchParams.get("server");

      /*
       * Normale Spieler dürfen niemals
       * einen fremden Server abfragen.
       *
       * Auch manipulierte URLs helfen nicht.
       */
      if (!isAdmin(user)) {
        requestedServer =
          user.server;
      }

      /*
       * Admin kann Server frei auswählen.
       * Ohne Angabe nehmen wir seinen
       * registrierten Server.
       */
      if (!requestedServer) {
        requestedServer =
          user.server;
      }

      result =
        await env.DB.prepare(`
          SELECT
            u.id,
            u.username,
            u.server,
            u.role,
            p.last_seen,
            p.room_type,
            p.server AS presence_server

          FROM chat_presence p

          JOIN users u
            ON u.id = p.user_id

          WHERE p.last_seen >= ?
            AND p.room_type = 'server'
            AND p.server = ?

          ORDER BY
            CASE
              WHEN u.role = 'admin'
              THEN 0
              ELSE 1
            END,
            LOWER(u.username) ASC
        `)
          .bind(
            cutoff,
            requestedServer
          )
          .all();
    }

    const players =
      (result.results || []).map(
        player => ({
          id:
            player.id,

          username:
            player.username,

          server:
            player.server,

          role:
            player.role,

          is_admin:
            player.role === "admin",

          last_seen:
            player.last_seen
        })
      );

    return json({
      ok: true,

      room,

      server:
        room === "server"
          ? (
              !isAdmin(user)
                ? user.server
                : (
                    url.searchParams.get(
                      "server"
                    ) || user.server
                  )
            )
          : null,

      online_timeout_seconds:
        ONLINE_TIMEOUT_SECONDS,

      count:
        players.length,

      players
    });

  } catch (error) {
    console.error(
      "GET /api/chat/online error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Online-Liste konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Aktualisiert die Aktivität eines Spielers.
 *
 * Das Frontend ruft diesen Endpoint später nur
 * dann auf, wenn echte Chat-Aktivität erkannt wurde:
 *
 * - Mausbewegung im Chat
 * - Klick im Chat
 * - Scrollen
 * - Tippen
 * - Nachricht senden
 * - Raum wechseln
 *
 * Beispiel Global:
 *
 * {
 *   "room": "global"
 * }
 *
 * Beispiel Server:
 *
 * {
 *   "room": "server"
 * }
 *
 * Admin darf zusätzlich:
 *
 * {
 *   "room": "server",
 *   "server": "Europa 1"
 * }
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json({
        ok: false,
        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const room =
      typeof body.room === "string"
        ? body.room.toLowerCase()
        : "";

    if (
      room !== "global" &&
      room !== "server"
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Chatraum."
      }, 400);
    }

    let server = null;

    /*
     * =============================================
     * GLOBAL
     * =============================================
     */
    if (room === "global") {
      server = null;
    }

    /*
     * =============================================
     * SERVERCHAT
     * =============================================
     */
    else {
      /*
       * Normaler Spieler:
       * zwingend eigener registrierter Server.
       */
      if (!isAdmin(user)) {
        server =
          user.server;
      }

      /*
       * Admin:
       * darf alle Server betreten.
       */
      else {
        server =
          typeof body.server === "string" &&
          body.server.trim()
            ? body.server.trim()
            : user.server;
      }
    }

    const now =
      Math.floor(Date.now() / 1000);

    /*
     * UPSERT:
     *
     * Pro Spieler existiert nur ein
     * Presence-Eintrag.
     *
     * Wechsel zwischen Global/Server ersetzt
     * automatisch den alten Zustand.
     */
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
        last_seen =
          excluded.last_seen,

        room_type =
          excluded.room_type,

        server =
          excluded.server
    `)
      .bind(
        user.id,
        now,
        room,
        server
      )
      .run();

    return json({
      ok: true,

      online: true,

      user: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        role:
          user.role,

        is_admin:
          isAdmin(user)
      },

      room,

      active_server:
        server,

      last_seen:
        now,

      expires_after_seconds:
        ONLINE_TIMEOUT_SECONDS
    });

  } catch (error) {
    console.error(
      "POST /api/chat/online error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Online-Status konnte nicht aktualisiert werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Optionales sofortiges Offline-Setzen.
 *
 * Kann später beim bewussten Verlassen des Chats
 * oder beim Logout benutzt werden.
 *
 * Ohne diesen Request verschwindet der Spieler
 * automatisch spätestens nach 10 Minuten.
 */
export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
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
    console.error(
      "DELETE /api/chat/online error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Online-Status konnte nicht entfernt werden."
    }, 500);
  }
}
