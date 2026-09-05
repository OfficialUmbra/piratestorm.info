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
  const cookie =
    request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] =
      part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(
        value.join("=")
      );
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const token =
    getCookie(
      request,
      "ps_session"
    );

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

    WHERE sessions.id = ?
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
 * Liefert die aktuell im Chat aktiven Spieler.
 *
 * WICHTIG:
 *
 * chat_presence besitzt nur eine Zeile pro Spieler.
 * Deshalb wird room_type NICHT mehr dazu verwendet,
 * einen Spieler aus anderen Chatlisten auszublenden.
 *
 * GLOBAL:
 * - zeigt alle aktuell aktiven Chatspieler
 *
 * SERVER:
 * - zeigt alle aktuell aktiven Spieler des Servers
 * - normaler Spieler: nur eigener Server
 * - Admin: ausgewählter Server
 *
 * Dadurch bleibt z.B. Umbra auch für DE1-Spieler
 * sichtbar, wenn Umbra zuletzt im Globalchat aktiv war.
 */
export async function onRequestGet(context) {
  try {
    const {
      request,
      env
    } = context;

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
      )
        .trim()
        .toLowerCase();

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
    let activeServer = null;

    /*
     * =================================================
     * GLOBALCHAT
     * =================================================
     *
     * Jeder Spieler, dessen Presence noch aktuell ist,
     * wird angezeigt.
     *
     * room_type spielt hier absichtlich keine Rolle.
     */
    if (room === "global") {
      result =
        await env.DB.prepare(`
          SELECT
            u.id,
            u.username,
            u.server,
            u.role,
            p.last_seen

          FROM chat_presence p

          JOIN users u
            ON u.id = p.user_id

          WHERE p.last_seen >= ?

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
     * =================================================
     * SERVERCHAT
     * =================================================
     */
    else {
      if (isAdmin(user)) {
        const requestedServer =
          url.searchParams.get("server");

        activeServer =
          typeof requestedServer === "string" &&
          requestedServer.trim()
            ? requestedServer.trim()
            : user.server;
      } else {
        /*
         * Normale Spieler können niemals eine
         * Online-Liste eines fremden Servers abrufen.
         */
        activeServer =
          user.server;
      }

      /*
       * Wichtig:
       *
       * Wir filtern nach users.server und NICHT nach
       * chat_presence.room_type / chat_presence.server.
       *
       * Presence sagt lediglich:
       * "Dieser Account ist gerade im Chat aktiv."
       *
       * Der registrierte Server des Accounts bestimmt,
       * in welcher Server-Online-Liste er erscheint.
       */
      result =
        await env.DB.prepare(`
          SELECT
            u.id,
            u.username,
            u.server,
            u.role,
            p.last_seen

          FROM chat_presence p

          JOIN users u
            ON u.id = p.user_id

          WHERE p.last_seen >= ?
            AND (
              u.server = ?
              OR u.role = 'admin'
            )

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
            activeServer
          )
          .all();
    }

    const players =
      (result.results || [])
        .map(player => ({
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
        }));

    return json({
      ok: true,

      room,

      server:
        activeServer,

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
 * Heartbeat des eingeloggten Spielers.
 *
 * Die Zeile wird weiterhin aktualisiert, damit wir
 * erkennen können, ob ein Spieler den Chat noch
 * geöffnet hat.
 *
 * room_type/server bleiben als Zusatzinformation
 * gespeichert, bestimmen aber NICHT mehr, ob jemand
 * grundsätzlich online angezeigt wird.
 */
export async function onRequestPost(context) {
  try {
    const {
      request,
      env
    } = context;

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

    let body = {};

    try {
      body =
        await request.json();
    } catch {
      /*
       * Heartbeat darf auch ohne sinnvollen Body
       * funktionieren.
       */
      body = {};
    }

    let room =
      typeof body.room === "string"
        ? body.room
            .trim()
            .toLowerCase()
        : "global";

    if (
      room !== "global" &&
      room !== "server"
    ) {
      room =
        "global";
    }

    let activeServer = null;

    if (room === "server") {
      if (isAdmin(user)) {
        activeServer =
          typeof body.server === "string" &&
          body.server.trim()
            ? body.server.trim()
            : user.server;
      } else {
        activeServer =
          user.server;
      }
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Pro Spieler existiert weiterhin genau
     * eine Presence-Zeile.
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
        activeServer
      )
      .run();

    return json({
      ok: true,

      online:
        true,

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
        activeServer,

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
 * Entfernt die Presence des eingeloggten Spielers.
 *
 * Kann z.B. beim Logout verwendet werden.
 */
export async function onRequestDelete(context) {
  try {
    const {
      request,
      env
    } = context;

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
      online:
        false
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
