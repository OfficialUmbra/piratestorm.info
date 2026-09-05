const ONLINE_TIMEOUT_SECONDS = 10 * 60;

const SERVER_MAP = {
  "Deutschland 1": "DE1",
  "Europa 1": "EU1",
  "Europa 2": "EU2",
  "Europa 3": "EU3",
  "Europa 4": "EU4",
  "Arabien 1": "AR1",
  "Lateinamerika 1": "LA1",
  "USA 1": "USA1"
};


/*
 * =====================================================
 * RESPONSE
 * =====================================================
 */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


/*
 * =====================================================
 * COOKIE
 * =====================================================
 */

function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get(
      "Cookie"
    ) || "";

  for (
    const part
    of cookie.split(";")
  ) {
    const [
      key,
      ...value
    ] =
      part
        .trim()
        .split("=");

    if (
      key === name
    ) {
      return decodeURIComponent(
        value.join("=")
      );
    }
  }

  return null;
}


/*
 * =====================================================
 * CURRENT USER
 * =====================================================
 */

async function getCurrentUser(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      "ps_session"
    );

  if (!sessionId) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.server,
      u.role

    FROM sessions s

    JOIN users u
      ON u.id = s.user_id

    WHERE s.id = ?
      AND s.expires_at > ?

    LIMIT 1
  `)
    .bind(
      sessionId,
      now
    )
    .first();
}


/*
 * =====================================================
 * HELPERS
 * =====================================================
 */

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}


function getServerCode(
  server,
  role = null
) {
  /*
   * V25:
   *
   * Admin zeigt nicht mehr DE1,
   * sondern ADMIN.
   */
  if (
    role === "admin"
  ) {
    return "ADMIN";
  }

  return (
    SERVER_MAP[server] ||
    server ||
    ""
  );
}


/*
 * =====================================================
 * EXPIRED PRESENCE CLEANUP
 * =====================================================
 */

async function cleanupExpiredPresence(
  env
) {
  const cutoff =
    Math.floor(
      Date.now() / 1000
    ) -
    ONLINE_TIMEOUT_SECONDS;

  await env.DB.prepare(`
    DELETE FROM chat_presence

    WHERE last_seen < ?
  `)
    .bind(
      cutoff
    )
    .run();
}


/*
 * =====================================================
 * EXPIRED BANS CLEANUP
 * =====================================================
 */

async function cleanupExpiredBans(
  env
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB.prepare(`
    UPDATE chat_bans

    SET active = 0

    WHERE active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(
      now
    )
    .run();
}


/*
 * =====================================================
 * ACTIVE BAN
 * =====================================================
 */

async function getActiveBan(
  env,
  user
) {
  /*
   * Admin ist immun.
   */
  if (
    !user ||
    isAdmin(user)
  ) {
    return null;
  }

  await cleanupExpiredBans(
    env
  );

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      id,
      user_id,
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

    ORDER BY
      banned_at DESC,
      id DESC

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
 * PLAYER FORMAT
 * =====================================================
 */

function formatPlayer(
  player
) {
  return {
    id:
      player.id,

    username:
      player.username,

    server:
      player.server,

    server_code:
      getServerCode(
        player.server,
        player.role
      ),

    role:
      player.role,

    is_admin:
      player.role ===
      "admin",

    /*
     * V25 Frontend kann daraus direkt den
     * kleinen grünen Punkt darstellen.
     */
    online:
      true,

    last_seen:
      player.last_seen
  };
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GLOBAL
 *
 * /api/chat/online?room=global
 *
 * -> alle aktuell aktiven Spieler
 *
 *
 * SERVER
 *
 * /api/chat/online?room=server&server=Deutschland%201
 *
 * Normaler Spieler:
 * eigener Server
 *
 * Admin:
 * kann einen Server auswählen
 *
 *
 * WICHTIG V25:
 *
 * p.room_type wird NICHT mehr für die Sichtbarkeit
 * verwendet.
 *
 * Eine Presence ist eine Presence des Accounts,
 * nicht eines einzelnen Tabs.
 * =====================================================
 */

export async function onRequestGet(
  context
) {
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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    /*
     * Gebannter aktueller Benutzer darf die
     * Online-Liste ebenfalls nicht als Chatfunktion
     * weiterverwenden.
     */
    const currentBan =
      await getActiveBan(
        env,
        user
      );

    if (currentBan) {
      /*
       * Eigene Presence direkt entfernen.
       */
      await env.DB.prepare(`
        DELETE FROM chat_presence

        WHERE user_id = ?
      `)
        .bind(
          user.id
        )
        .run();

      return json({
        ok:
          false,

        code:
          "CHAT_BANNED",

        error:
          "Du bist derzeit vom Chat ausgeschlossen."
      }, 403);
    }

    await Promise.all([
      cleanupExpiredPresence(
        env
      ),

      cleanupExpiredBans(
        env
      )
    ]);

    const url =
      new URL(
        request.url
      );

    const room =
      (
        url.searchParams.get(
          "room"
        ) ||
        "global"
      )
        .trim()
        .toLowerCase();

    if (
      room !== "global" &&
      room !== "server"
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültiger Chatraum."
      }, 400);
    }

    const cutoff =
      Math.floor(
        Date.now() / 1000
      ) -
      ONLINE_TIMEOUT_SECONDS;

    let result;
    let activeServer =
      null;

    /*
     * =================================================
     * GLOBAL
     * =================================================
     *
     * Alle aktiven Spieler.
     *
     * Gebannte Accounts werden ausgeschlossen.
     */
    if (
      room ===
      "global"
    ) {
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
            ON u.id =
              p.user_id

          WHERE p.last_seen >= ?

            AND (
              u.role = 'admin'

              OR NOT EXISTS (
                SELECT 1

                FROM chat_bans b

                WHERE b.user_id =
                  u.id

                  AND b.active = 1

                  AND (
                    b.expires_at
                      IS NULL

                    OR b.expires_at > ?
                  )
              )
            )

          ORDER BY
            CASE
              WHEN u.role =
                'admin'
              THEN 0
              ELSE 1
            END,

            LOWER(
              u.username
            ) ASC
        `)
          .bind(
            cutoff,
            Math.floor(
              Date.now() / 1000
            )
          )
          .all();
    }

    /*
     * =================================================
     * SERVER
     * =================================================
     */
    else {
      if (
        isAdmin(user)
      ) {
        activeServer =
          (
            url.searchParams.get(
              "server"
            ) ||
            user.server
          )
            .trim();
      } else {
        activeServer =
          user.server;
      }

      if (
        !activeServer ||
        !SERVER_MAP[
          activeServer
        ]
      ) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Server."
        }, 400);
      }

      /*
       * Spieler des ausgewählten Servers
       * +
       * Admin unabhängig von dessen registriertem
       * Server.
       *
       * Dadurch bleibt Umbra in jedem öffentlichen
       * Serverchat sichtbar, den er gerade moderiert.
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
            ON u.id =
              p.user_id

          WHERE p.last_seen >= ?

            AND (
              u.server = ?
              OR u.role =
                'admin'
            )

            AND (
              u.role = 'admin'

              OR NOT EXISTS (
                SELECT 1

                FROM chat_bans b

                WHERE b.user_id =
                  u.id

                  AND b.active = 1

                  AND (
                    b.expires_at
                      IS NULL

                    OR b.expires_at > ?
                  )
              )
            )

          ORDER BY
            CASE
              WHEN u.role =
                'admin'
              THEN 0
              ELSE 1
            END,

            LOWER(
              u.username
            ) ASC
        `)
          .bind(
            cutoff,
            activeServer,
            Math.floor(
              Date.now() / 1000
            )
          )
          .all();
    }

    const players =
      (
        result.results || []
      ).map(
        formatPlayer
      );

    return json({
      ok:
        true,

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
      ok:
        false,

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
 * HEARTBEAT
 *
 * {
 *   room: "global"
 * }
 *
 * oder:
 *
 * {
 *   room: "server",
 *   server: "Deutschland 1"
 * }
 *
 *
 * room_type/server werden weiterhin gespeichert,
 * falls wir sie später brauchen.
 *
 * Die ONLINE-SICHTBARKEIT hängt aber nicht mehr
 * davon ab.
 * =====================================================
 */

export async function onRequestPost(
  context
) {
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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    /*
     * =================================================
     * BAN CHECK
     * =================================================
     */
    const ban =
      await getActiveBan(
        env,
        user
      );

    if (ban) {
      /*
       * Falls noch eine alte Presence existiert:
       * sofort entfernen.
       */
      await env.DB.prepare(`
        DELETE FROM chat_presence

        WHERE user_id = ?
      `)
        .bind(
          user.id
        )
        .run();

      return json({
        ok:
          false,

        code:
          "CHAT_BANNED",

        error:
          "Du bist derzeit vom Chat ausgeschlossen."
      }, 403);
    }

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const room =
      typeof body.room ===
      "string"
        ? body.room
            .trim()
            .toLowerCase()
        : "";

    if (
      room !== "global" &&
      room !== "server"
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültiger Chatraum."
      }, 400);
    }

    let server =
      null;

    if (
      room ===
      "server"
    ) {
      if (
        isAdmin(user)
      ) {
        server =
          typeof body.server ===
            "string" &&
          body.server.trim()
            ? body.server.trim()
            : user.server;
      } else {
        server =
          user.server;
      }

      if (
        !server ||
        !SERVER_MAP[server]
      ) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Server."
        }, 400);
      }
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Eine Presence-Zeile pro Account.
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
      ok:
        true,

      online:
        true,

      user: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        server_code:
          getServerCode(
            user.server,
            user.role
          ),

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
      ok:
        false,

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
 * Presence manuell entfernen.
 * =====================================================
 */

export async function onRequestDelete(
  context
) {
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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    await env.DB.prepare(`
      DELETE FROM chat_presence

      WHERE user_id = ?
    `)
      .bind(
        user.id
      )
      .run();

    return json({
      ok:
        true,

      online:
        false
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/online error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Der Online-Status konnte nicht entfernt werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 */

export async function onRequestPut() {
  return json({
    ok:
      false,

    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}
