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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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


function cleanText(value) {
  return typeof value ===
    "string"
    ? value.trim()
    : "";
}


/*
 * =====================================================
 * ACTIVE BAN
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
    .bind(now)
    .run();
}


async function isActivelyBanned(
  env,
  userId
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const row =
    await env.DB.prepare(`
      SELECT id

      FROM chat_bans

      WHERE user_id = ?
        AND active = 1
        AND (
          expires_at IS NULL
          OR expires_at > ?
        )

      LIMIT 1
    `)
      .bind(
        userId,
        now
      )
      .first();

  return Boolean(row);
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Beispiele:
 *
 * /api/chat/users
 *
 * /api/chat/users?q=cap
 *
 * /api/chat/users?q=jack&limit=10
 *
 *
 * Zweck:
 *
 * - @Mention-Auswahl
 * - Whisper-Neuanlage
 * - weitere Spieler in Whisper einladen
 *
 *
 * NORMALER SPIELER:
 * sieht nur registrierte Spieler des eigenen Servers.
 *
 * ADMIN:
 * sieht ebenfalls Spieler des eigenen Serverkontexts.
 * Für fremde Server wird später im Frontend der
 * passende Server übergeben.
 *
 * Optional:
 *
 * ?server=Europa%201
 *
 * ist ausschließlich für Admin erlaubt.
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
     * Gebannte Spieler dürfen die Usersuche als
     * Chatfunktion nicht verwenden.
     */
    if (!isAdmin(user)) {
      await cleanupExpiredBans(
        env
      );

      const banned =
        await isActivelyBanned(
          env,
          user.id
        );

      if (banned) {
        return json({
          ok:
            false,

          code:
            "CHAT_BANNED",

          error:
            "Du bist derzeit vom Chat ausgeschlossen."
        }, 403);
      }
    }

    const url =
      new URL(
        request.url
      );

    const query =
      cleanText(
        url.searchParams.get(
          "q"
        )
      );

    let rawLimit =
      Number(
        url.searchParams.get(
          "limit"
        ) ||
        DEFAULT_LIMIT
      );

    if (
      !Number.isInteger(
        rawLimit
      )
    ) {
      rawLimit =
        DEFAULT_LIMIT;
    }

    const limit =
      Math.max(
        1,
        Math.min(
          rawLimit,
          MAX_LIMIT
        )
      );

    /*
     * =================================================
     * SERVER
     * =================================================
     */
    let server =
      user.server;

    const requestedServer =
      cleanText(
        url.searchParams.get(
          "server"
        )
      );

    if (
      requestedServer
    ) {
      if (
        !isAdmin(user)
      ) {
        return json({
          ok:
            false,

          error:
            "Du kannst nur Spieler deines eigenen Servers durchsuchen."
        }, 403);
      }

      if (
        !SERVER_MAP[
          requestedServer
        ]
      ) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Server."
        }, 400);
      }

      server =
        requestedServer;
    }

    /*
     * =================================================
     * USERS QUERY
     * =================================================
     *
     * Admin wird mit angezeigt, unabhängig von seinem
     * registrierten Server.
     *
     * Gebannte normale Spieler werden aus der
     * Auswahl entfernt.
     *
     * Eigener Account wird nicht vorgeschlagen.
     *
     * Blockierte Accounts werden für normale Nutzer
     * ebenfalls nicht vorgeschlagen.
     * =================================================
     */

    const searchLike =
      `%${query}%`;

    const result =
      await env.DB.prepare(`
        SELECT
          u.id,
          u.username,
          u.server,
          u.role,

          p.last_seen,

          CASE
            WHEN p.last_seen IS NOT NULL
              AND p.last_seen >= ?
            THEN 1
            ELSE 0
          END AS online

        FROM users u

        LEFT JOIN chat_presence p
          ON p.user_id =
            u.id

        WHERE u.id != ?

          AND (
            u.server = ?
            OR u.role =
              'admin'
          )

          AND (
            ? = ''
            OR LOWER(
              u.username
            ) LIKE LOWER(?)
          )

          AND (
            u.role =
              'admin'

            OR NOT EXISTS (
              SELECT 1

              FROM chat_bans b

              WHERE b.user_id =
                u.id

                AND b.active = 1

                AND (
                  b.expires_at IS NULL
                  OR b.expires_at > ?
                )
            )
          )

          AND (
            u.role =
              'admin'

            OR NOT EXISTS (
              SELECT 1

              FROM chat_blocks cb

              WHERE
                (
                  cb.blocker_id = ?
                  AND cb.blocked_id =
                    u.id
                )

                OR
                (
                  cb.blocker_id =
                    u.id
                  AND cb.blocked_id = ?
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

          CASE
            WHEN p.last_seen IS NOT NULL
              AND p.last_seen >= ?
            THEN 0
            ELSE 1
          END,

          LOWER(
            u.username
          ) ASC

        LIMIT ?
      `)
        .bind(
          Math.floor(
            Date.now() / 1000
          ) -
          10 * 60,

          user.id,

          server,

          query,

          searchLike,

          Math.floor(
            Date.now() / 1000
          ),

          user.id,
          user.id,

          Math.floor(
            Date.now() / 1000
          ) -
          10 * 60,

          limit
        )
        .all();

    const players =
      (
        result.results || []
      ).map(
        row => ({
          id:
            row.id,

          username:
            row.username,

          server:
            row.server,

          server_code:
            getServerCode(
              row.server,
              row.role
            ),

          role:
            row.role,

          is_admin:
            row.role ===
            "admin",

          online:
            Boolean(
              row.online
            )
        })
      );

    return json({
      ok:
        true,

      server,

      query,

      count:
        players.length,

      players
    });

  } catch (error) {
    console.error(
      "GET /api/chat/users error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Spielersuche konnte nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * POST
 * =====================================================
 */

export async function onRequestPost() {
  return json({
    ok:
      false,

    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
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


/*
 * =====================================================
 * DELETE
 * =====================================================
 */

export async function onRequestDelete() {
  return json({
    ok:
      false,

    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}
