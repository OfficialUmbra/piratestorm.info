const ONLINE_TIMEOUT_SECONDS = 10 * 60;

const SERVERS = [
  "Arabien 1",
  "Deutschland 1",
  "Europa 1",
  "Europa 2",
  "Europa 3",
  "Europa 4",
  "Lateinamerika 1",
  "USA 1"
];

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

function isValidServer(server) {
  return SERVERS.includes(server);
}

/*
 * =====================================================
 * ALTE PRESENCE-EINTRÄGE ENTFERNEN
 * =====================================================
 *
 * Nach 10 Minuten ohne echte Chat-Aktivität
 * gilt ein Spieler als offline.
 */
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
 * ABGELAUFENE CHAT-BANS DEAKTIVIEREN
 * =====================================================
 *
 * Permanente Bans haben expires_at = NULL.
 */
async function cleanupExpiredBans(env) {
  const now =
    Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    UPDATE chat_bans
    SET active = 0
    WHERE active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(now)
    .run();
}

/*
 * =====================================================
 * AKTIVEN CHAT-BAN PRÜFEN
 * =====================================================
 *
 * Admin-Accounts sind grundsätzlich immun.
 *
 * Selbst falls durch alte/manipulierte Daten ein
 * chat_bans-Eintrag für einen Admin existiert,
 * wird er hier nicht angewendet.
 */
async function getActiveChatBan(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  const now =
    Math.floor(Date.now() / 1000);

  return await env.DB.prepare(`
    SELECT
      id,
      reason,
      banned_at,
      expires_at
    FROM chat_bans
    WHERE user_id = ?
      AND active = 1
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )
    ORDER BY banned_at DESC, id DESC
    LIMIT 1
  `)
    .bind(
      user.id,
      now
    )
    .first();
}

/*
 * =====================================================
 * GEBANNTEN SPIELER AUS PRESENCE ENTFERNEN
 * =====================================================
 */
async function removePresence(env, userId) {
  await env.DB.prepare(`
    DELETE FROM chat_presence
    WHERE user_id = ?
  `)
    .bind(userId)
    .run();
}

/*
 * =====================================================
 * BAN-ANTWORT
 * =====================================================
 */
function bannedResponse(ban) {
  return json({
    ok: false,
    banned: true,
    error:
      "Du bist derzeit vom Chat ausgeschlossen.",
    ban: {
      id:
        ban.id,

      reason:
        ban.reason || null,

      banned_at:
        ban.banned_at,

      expires_at:
        ban.expires_at
    }
  }, 403);
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
 * Admin:
 * /api/chat/online?room=server&server=Europa%201
 *
 * Normale Spieler können ausschließlich ihren
 * eigenen registrierten Server sehen.
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

    /*
     * Abgelaufene Daten zuerst bereinigen.
     */
    await cleanupExpiredBans(env);
    await cleanupExpiredPresence(env);

    /*
     * Ein Chat-Ban sperrt den gesamten Chat.
     */
    const activeBan =
      await getActiveChatBan(
        env,
        user
      );

    if (activeBan) {
      await removePresence(
        env,
        user.id
      );

      return bannedResponse(
        activeBan
      );
    }

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
     * =============================================
     * GLOBALCHAT
     * =============================================
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

            AND (
              u.role = 'admin'
              OR NOT EXISTS (
                SELECT 1
                FROM chat_bans b
                WHERE b.user_id = u.id
                  AND b.active = 1
                  AND (
                    b.expires_at IS NULL
                    OR b.expires_at > ?
                  )
              )
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
            Math.floor(Date.now() / 1000)
          )
          .all();
    }

    /*
     * =============================================
     * SERVERCHAT
     * =============================================
     */
    else {
      /*
       * Normale Nutzer werden immer auf ihren
       * registrierten Server gezwungen.
       */
      if (!isAdmin(user)) {
        activeServer =
          user.server;
      }

      /*
       * Admin darf einen Server auswählen.
       */
      else {
        const requestedServer =
          (
            url.searchParams.get("server") ||
            user.server ||
            ""
          ).trim();

        if (
          !isValidServer(
            requestedServer
          )
        ) {
          return json({
            ok: false,
            error:
              "Ungültiger Server."
          }, 400);
        }

        activeServer =
          requestedServer;
      }

      /*
       * Zusätzliche Sicherheit:
       * Auch der eigene gespeicherte Server eines
       * normalen Accounts muss gültig sein.
       */
      if (
        !isValidServer(
          activeServer
        )
      ) {
        return json({
          ok: false,
          error:
            "Ungültiger Server."
        }, 400);
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

            AND (
              u.role = 'admin'
              OR NOT EXISTS (
                SELECT 1
                FROM chat_bans b
                WHERE b.user_id = u.id
                  AND b.active = 1
                  AND (
                    b.expires_at IS NULL
                    OR b.expires_at > ?
                  )
              )
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
            activeServer,
            Math.floor(Date.now() / 1000)
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
          ? activeServer
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
 * Aktualisiert echte Chat-Aktivität.
 *
 * Das Frontend soll diesen Endpoint später bei
 * tatsächlicher Aktivität verwenden:
 *
 * - Mausbewegung im Chatbereich
 * - Klick
 * - Scrollen
 * - Tippen
 * - Nachricht senden
 * - Chatraum wechseln
 *
 * Dabei nicht bei jedem Mousemove senden.
 * Frontend-seitig drosseln wir später auf ungefähr
 * einmal pro Minute.
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

    await cleanupExpiredBans(env);
    await cleanupExpiredPresence(env);

    /*
     * Gebannte Spieler dürfen sich nicht erneut
     * als online eintragen.
     */
    const activeBan =
      await getActiveChatBan(
        env,
        user
      );

    if (activeBan) {
      await removePresence(
        env,
        user.id
      );

      return bannedResponse(
        activeBan
      );
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
        ? body.room
            .trim()
            .toLowerCase()
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
     * GLOBALCHAT
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
       * Normale Spieler:
       * immer der eigene registrierte Server.
       *
       * body.server wird ignoriert.
       */
      if (!isAdmin(user)) {
        server =
          user.server;
      }

      /*
       * Admin:
       * darf jeden gültigen Server betreten.
       */
      else {
        server =
          typeof body.server === "string" &&
          body.server.trim()
            ? body.server.trim()
            : user.server;
      }

      /*
       * Manipulierte/falsche Servernamen werden
       * für alle Rollen abgelehnt.
       */
      if (
        !isValidServer(server)
      ) {
        return json({
          ok: false,
          error:
            "Ungültiger Server."
        }, 400);
      }
    }

    const now =
      Math.floor(Date.now() / 1000);

    /*
     * =================================================
     * UPSERT PRESENCE
     * =================================================
     *
     * Pro Account gibt es einen Presence-Eintrag.
     *
     * Beim Wechsel zwischen Global- und Serverchat
     * wird der aktuelle Raum ersetzt.
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
 * Setzt den eigenen Account sofort offline.
 *
 * Das darf auch funktionieren, wenn der Spieler
 * inzwischen gebannt wurde, damit kein alter
 * Presence-Eintrag hängen bleibt.
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

    await removePresence(
      env,
      user.id
    );

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
