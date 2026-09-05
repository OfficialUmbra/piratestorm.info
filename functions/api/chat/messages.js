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

const MESSAGE_MAX_LENGTH = 1000;
const MESSAGE_LIMIT = 200;

/*
 * =====================================================
 * JSON RESPONSE
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
 * ADMIN
 * =====================================================
 */
function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

/*
 * =====================================================
 * CLEAN TEXT
 * =====================================================
 */
function cleanText(value) {
  return typeof value ===
    "string"
    ? value.trim()
    : "";
}

/*
 * =====================================================
 * POSITIVE INTEGER
 * =====================================================
 */
function toPositiveInt(value) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}

/*
 * =====================================================
 * EXPIRED BANS
 * =====================================================
 */
async function expireOldBans(
  env,
  userId
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB.prepare(`
    UPDATE chat_bans

    SET active = 0

    WHERE user_id = ?
      AND active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(
      userId,
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
   * Admin-Immunität.
   */
  if (
    !user ||
    isAdmin(user)
  ) {
    return null;
  }

  await expireOldBans(
    env,
    user.id
  );

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      b.id,
      b.user_id,
      b.banned_by,
      b.reason,
      b.banned_at,
      b.expires_at,
      b.active,

      admin.username
        AS banned_by_username

    FROM chat_bans b

    LEFT JOIN users admin
      ON admin.id =
        b.banned_by

    WHERE b.user_id = ?
      AND b.active = 1
      AND (
        b.expires_at IS NULL
        OR b.expires_at > ?
      )

    ORDER BY
      b.banned_at DESC,
      b.id DESC

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
 * BAN RESPONSE
 * =====================================================
 */
function bannedResponse(
  ban
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const permanent =
    ban.expires_at === null;

  return {
    ok:
      false,

    error:
      "Du bist aktuell aus dem Chat gebannt.",

    code:
      "CHAT_BANNED",

    banned:
      true,

    ban: {
      id:
        ban.id,

      reason:
        ban.reason || null,

      banned_at:
        ban.banned_at,

      expires_at:
        ban.expires_at,

      permanent,

      remaining_seconds:
        permanent
          ? null
          : Math.max(
              0,
              Number(
                ban.expires_at
              ) - now
            ),

      banned_by: {
        id:
          ban.banned_by,

        username:
          ban.banned_by_username ||
          null
      }
    }
  };
}

/*
 * =====================================================
 * BLOCKED USER IDS
 * =====================================================
 *
 * Nachrichten von Spielern, die der aktuelle Nutzer
 * blockiert hat, werden für ihn ausgeblendet.
 */
async function getBlockedUserIds(
  env,
  userId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        blocked_id

      FROM chat_blocks

      WHERE blocker_id = ?
    `)
      .bind(userId)
      .all();

  return new Set(
    (
      result.results || []
    ).map(
      row =>
        Number(
          row.blocked_id
        )
    )
  );
}

/*
 * =====================================================
 * MESSAGE OUTPUT
 * =====================================================
 */
function formatMessage(
  row
) {
  return {
    id:
      row.id,

    user_id:
      row.user_id,

    username:
      row.username,

    server:
      row.user_server,

    server_code:
      SERVER_MAP[
        row.user_server
      ] ||
      row.user_server ||
      "",

    role:
      row.user_role,

    is_admin:
      row.user_role ===
      "admin",

    room:
      row.room_type,

    room_type:
      row.room_type,

    room_server:
      row.server || null,

    message:
      row.message,

    content:
      row.message,

    reply_to:
      row.reply_to || null,

    reply_username:
      row.reply_username || null,

    reply_excerpt:
      row.reply_to
        ? (
            row.reply_message ||
            ""
          ).slice(
            0,
            120
          )
        : null,

    created_at:
      row.created_at
  };
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GLOBAL:
 *
 * /api/chat/messages?room=global
 *
 * SERVER:
 *
 * /api/chat/messages?room=server&server=Deutschland%201
 *
 *
 * WICHTIGE NEUE REGEL:
 *
 * Ein gebannter Spieler erhält KEINE Chatnachrichten.
 *
 * Das gilt serverseitig und kann deshalb nicht einfach
 * durch manipuliertes Frontend umgangen werden.
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
     * =================================================
     * BAN CHECK VOR DEM LADEN
     * =================================================
     */
    const ban =
      await getActiveBan(
        env,
        user
      );

    if (ban) {
      return json(
        bannedResponse(
          ban
        ),
        403
      );
    }

    const url =
      new URL(
        request.url
      );

    const room =
      cleanText(
        url.searchParams.get(
          "room"
        ) || "global"
      ).toLowerCase();

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

    let server = null;

    /*
     * =================================================
     * SERVERCHAT ACCESS
     * =================================================
     */
    if (
      room === "server"
    ) {
      const requestedServer =
        cleanText(
          url.searchParams.get(
            "server"
          )
        );

      if (
        isAdmin(user)
      ) {
        /*
         * Admin darf alle öffentlichen Serverchats
         * öffnen.
         */
        server =
          requestedServer ||
          user.server;
      } else {
        /*
         * Normale Spieler dürfen ausschließlich den
         * eigenen registrierten Serverchat lesen.
         */
        if (
          requestedServer &&
          requestedServer !==
          user.server
        ) {
          return json({
            ok:
              false,

            error:
              "Du hast keinen Zugriff auf diesen Serverchat."
          }, 403);
        }

        server =
          user.server;
      }
    }

    /*
     * =================================================
     * NACHRICHTEN LADEN
     * =================================================
     */
    let result;

    if (
      room === "global"
    ) {
      result =
        await env.DB.prepare(`
          SELECT
            cm.id,
            cm.user_id,
            cm.room_type,
            cm.server,
            cm.message,
            cm.original_message,
            cm.reply_to,
            cm.created_at,

            u.username,
            u.server
              AS user_server,
            u.role
              AS user_role,

            reply_user.username
              AS reply_username,

            reply_message.message
              AS reply_message

          FROM chat_messages cm

          JOIN users u
            ON u.id =
              cm.user_id

          LEFT JOIN chat_messages reply_message
            ON reply_message.id =
              cm.reply_to

          LEFT JOIN users reply_user
            ON reply_user.id =
              reply_message.user_id

          WHERE cm.room_type =
            'global'

            AND cm.deleted_at
              IS NULL

          ORDER BY
            cm.created_at DESC,
            cm.id DESC

          LIMIT ?
        `)
          .bind(
            MESSAGE_LIMIT
          )
          .all();
    } else {
      result =
        await env.DB.prepare(`
          SELECT
            cm.id,
            cm.user_id,
            cm.room_type,
            cm.server,
            cm.message,
            cm.original_message,
            cm.reply_to,
            cm.created_at,

            u.username,
            u.server
              AS user_server,
            u.role
              AS user_role,

            reply_user.username
              AS reply_username,

            reply_message.message
              AS reply_message

          FROM chat_messages cm

          JOIN users u
            ON u.id =
              cm.user_id

          LEFT JOIN chat_messages reply_message
            ON reply_message.id =
              cm.reply_to

          LEFT JOIN users reply_user
            ON reply_user.id =
              reply_message.user_id

          WHERE cm.room_type =
            'server'

            AND cm.server = ?

            AND cm.deleted_at
              IS NULL

          ORDER BY
            cm.created_at DESC,
            cm.id DESC

          LIMIT ?
        `)
          .bind(
            server,
            MESSAGE_LIMIT
          )
          .all();
    }

    /*
     * SQL lädt neueste zuerst, UI soll aber
     * chronologisch anzeigen.
     */
    const rows =
      (
        result.results || []
      ).reverse();

    const blocked =
      await getBlockedUserIds(
        env,
        user.id
      );

    /*
     * Admin darf aufgrund seiner Immunität nicht
     * effektiv blockiert werden.
     *
     * Falls alte ungültige Block-Datensätze vorhanden
     * sind, werden Admin-Nachrichten trotzdem gezeigt.
     */
    const messages =
      rows
        .filter(row => {
          if (
            row.user_role ===
            "admin"
          ) {
            return true;
          }

          return !blocked.has(
            Number(
              row.user_id
            )
          );
        })
        .map(
          formatMessage
        );

    return json({
      ok:
        true,

      room,

      server,

      messages
    });

  } catch (error) {
    console.error(
      "GET /api/chat/messages error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Chatnachrichten konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Nachricht senden.
 *
 * Body:
 *
 * {
 *   "room": "global",
 *   "message": "Hallo",
 *   "reply_to": null
 * }
 *
 * oder:
 *
 * {
 *   "room": "server",
 *   "server": "Deutschland 1",
 *   "message": "Hallo",
 *   "reply_to": null
 * }
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
     * BAN CHECK VOR DEM SENDEN
     * =================================================
     */
    const ban =
      await getActiveBan(
        env,
        user
      );

    if (ban) {
      return json(
        bannedResponse(
          ban
        ),
        403
      );
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
      cleanText(
        body.room ||
        body.room_type
      ).toLowerCase();

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

    const message =
      cleanText(
        body.message
      );

    if (!message) {
      return json({
        ok:
          false,

        error:
          "Die Nachricht darf nicht leer sein."
      }, 400);
    }

    /*
     * Unicode-Emojis sind normale Zeichen.
     *
     * 😀 😂 ❤️ 👍 🔥 😎 usw. benötigen keine
     * Sonderbehandlung und werden direkt gespeichert.
     */
    if (
      message.length >
      MESSAGE_MAX_LENGTH
    ) {
      return json({
        ok:
          false,

        error:
          `Die Nachricht darf maximal ${MESSAGE_MAX_LENGTH} Zeichen lang sein.`
      }, 400);
    }

    let server = null;

    if (
      room === "server"
    ) {
      const requestedServer =
        cleanText(
          body.server
        );

      if (
        isAdmin(user)
      ) {
        server =
          requestedServer ||
          user.server;
      } else {
        /*
         * Normale Spieler können nicht durch einen
         * manipulierten Request in fremde Serverchats
         * schreiben.
         */
        if (
          requestedServer &&
          requestedServer !==
          user.server
        ) {
          return json({
            ok:
              false,

            error:
              "Du kannst nur in deinem eigenen Serverchat schreiben."
          }, 403);
        }

        server =
          user.server;
      }
    }

    /*
     * =================================================
     * REPLY VALIDIEREN
     * =================================================
     */
    let replyTo = null;

    if (
      body.reply_to !==
        null &&
      body.reply_to !==
        undefined &&
      body.reply_to !==
        ""
    ) {
      replyTo =
        toPositiveInt(
          body.reply_to
        );

      if (!replyTo) {
        return json({
          ok:
            false,

          error:
            "Ungültige Antwort-Nachricht."
        }, 400);
      }

      let reply;

      if (
        room === "global"
      ) {
        reply =
          await env.DB.prepare(`
            SELECT
              id

            FROM chat_messages

            WHERE id = ?
              AND room_type =
                'global'
              AND deleted_at
                IS NULL

            LIMIT 1
          `)
            .bind(
              replyTo
            )
            .first();
      } else {
        reply =
          await env.DB.prepare(`
            SELECT
              id

            FROM chat_messages

            WHERE id = ?
              AND room_type =
                'server'
              AND server = ?
              AND deleted_at
                IS NULL

            LIMIT 1
          `)
            .bind(
              replyTo,
              server
            )
            .first();
      }

      if (!reply) {
        return json({
          ok:
            false,

          error:
            "Die Nachricht, auf die du antworten möchtest, wurde nicht gefunden."
        }, 404);
      }
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * =================================================
     * SPEICHERN
     * =================================================
     *
     * Keine automatische Übersetzung.
     *
     * original_message bleibt für Moderation /
     * Wortfilter erhalten.
     */
    const inserted =
      await env.DB.prepare(`
        INSERT INTO chat_messages (
          user_id,
          room_type,
          server,
          message,
          original_message,
          reply_to,
          created_at
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )

        RETURNING id
      `)
        .bind(
          user.id,
          room,
          server,
          message,
          message,
          replyTo,
          now
        )
        .first();

    return json({
      ok:
        true,

      message: {
        id:
          inserted?.id ||
          null,

        user_id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        server_code:
          SERVER_MAP[
            user.server
          ] ||
          user.server ||
          "",

        role:
          user.role,

        is_admin:
          isAdmin(user),

        room,

        room_type:
          room,

        room_server:
          server,

        message,

        content:
          message,

        reply_to:
          replyTo,

        created_at:
          now
      }
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/messages error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Nachricht konnte nicht gesendet werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Nur Admin darf öffentliche Chatnachrichten löschen.
 *
 * Aufruf:
 *
 * DELETE /api/chat/messages?id=123
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

    if (
      !isAdmin(user)
    ) {
      return json({
        ok:
          false,

        error:
          "Nur Administratoren dürfen Chatnachrichten löschen."
      }, 403);
    }

    const url =
      new URL(
        request.url
      );

    const messageId =
      toPositiveInt(
        url.searchParams.get(
          "id"
        )
      );

    if (!messageId) {
      return json({
        ok:
          false,

        error:
          "Ungültige Nachrichten-ID."
      }, 400);
    }

    const message =
      await env.DB.prepare(`
        SELECT
          cm.id,
          cm.user_id,
          cm.room_type,
          cm.server,
          cm.message,
          cm.original_message,
          cm.deleted_at,

          u.username,
          u.role

        FROM chat_messages cm

        JOIN users u
          ON u.id =
            cm.user_id

        WHERE cm.id = ?

        LIMIT 1
      `)
        .bind(
          messageId
        )
        .first();

    if (!message) {
      return json({
        ok:
          false,

        error:
          "Nachricht wurde nicht gefunden."
      }, 404);
    }

    if (
      message.deleted_at !==
        null &&
      message.deleted_at !==
        undefined
    ) {
      return json({
        ok:
          true,

        already_deleted:
          true,

        message_id:
          message.id
      });
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      UPDATE chat_messages

      SET deleted_at = ?

      WHERE id = ?
        AND deleted_at IS NULL
    `)
      .bind(
        now,
        messageId
      )
      .run();

    /*
     * Moderationsprotokoll.
     */
    try {
      await env.DB.prepare(`
        INSERT INTO chat_moderation_log (
          admin_id,
          target_user_id,
          action,
          details,
          created_at
        )

        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(
          user.id,
          message.user_id,
          "delete_message",
          JSON.stringify({
            message_id:
              message.id,

            room_type:
              message.room_type,

            server:
              message.server,

            username:
              message.username,

            original_message:
              message.original_message ||
              message.message
          }),
          now
        )
        .run();
    } catch (logError) {
      /*
       * Löschen selbst soll nicht fehlschlagen,
       * nur weil das Moderationslog ein Problem hat.
       */
      console.error(
        "Moderation log error:",
        logError
      );
    }

    return json({
      ok:
        true,

      message_id:
        messageId,

      deleted_at:
        now
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/messages error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Nachricht konnte nicht gelöscht werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Spieler können Nachrichten nicht bearbeiten.
 * Admin soll ebenfalls löschen statt fremde
 * Nachrichten umzuschreiben.
 */
export async function onRequestPut() {
  return json({
    ok:
      false,

    error:
      "Chatnachrichten können nicht bearbeitet werden."
  }, 405);
}
