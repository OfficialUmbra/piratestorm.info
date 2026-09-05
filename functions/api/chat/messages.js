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

const MESSAGE_MAX_LENGTH = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const FLOOD_WINDOW_SECONDS = 10;
const FLOOD_MAX_MESSAGES = 5;

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
 * BASIC HELPERS
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
   * Bei Admins steht nicht mehr DE1 / EU1 usw.,
   * sondern immer ADMIN.
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

function getRoomLanguage(
  roomType,
  server
) {
  if (
    roomType === "global"
  ) {
    return "en";
  }

  if (
    server ===
    "Deutschland 1"
  ) {
    return "de";
  }

  return "en";
}

function normalizeMessage(
  value
) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function toPositiveInt(
  value
) {
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
 * BAN
 * =====================================================
 */

async function cleanExpiredBans(
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

  await cleanExpiredBans(
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

function createBanResponse(
  ban
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const permanent =
    ban.expires_at ===
    null;

  return {
    ok:
      false,

    error:
      "Du bist derzeit vom Chat ausgeschlossen.",

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
 * ROOM VALIDATION
 * =====================================================
 */

function validateRoom(
  user,
  roomType,
  requestedServer
) {
  if (
    roomType === "global"
  ) {
    return {
      ok:
        true,

      roomType:
        "global",

      server:
        null
    };
  }

  if (
    roomType !== "server"
  ) {
    return {
      ok:
        false,

      error:
        "Ungültiger Chatraum."
    };
  }

  /*
   * Admin darf jeden existierenden öffentlichen
   * Serverchat öffnen.
   */
  if (
    isAdmin(user)
  ) {
    const server =
      requestedServer ||
      user.server;

    if (
      !SERVER_MAP[server]
    ) {
      return {
        ok:
          false,

        error:
          "Ungültiger Server."
      };
    }

    return {
      ok:
        true,

      roomType:
        "server",

      server
    };
  }

  /*
   * Normaler Account:
   * immer eigener registrierter Server.
   */
  if (
    !SERVER_MAP[
      user.server
    ]
  ) {
    return {
      ok:
        false,

      error:
        "Ungültiger Server."
    };
  }

  if (
    requestedServer &&
    requestedServer !==
    user.server
  ) {
    return {
      ok:
        false,

      error:
        "Du hast keinen Zugriff auf diesen Serverchat."
    };
  }

  return {
    ok:
      true,

    roomType:
      "server",

    server:
      user.server
  };
}

/*
 * =====================================================
 * WORD FILTER
 * =====================================================
 */

function censorMessage(text) {
  const blockedWords = [
    "arschloch",
    "hurensohn",
    "wichser",
    "fotze",
    "missgeburt"
  ];

  let result =
    text;

  for (
    const word
    of blockedWords
  ) {
    const escaped =
      word.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const regex =
      new RegExp(
        `\\b${escaped}\\b`,
        "giu"
      );

    result =
      result.replace(
        regex,
        match =>
          "*".repeat(
            match.length
          )
      );
  }

  return result;
}

/*
 * =====================================================
 * FLOOD / DUPLICATE PROTECTION
 * =====================================================
 */

async function checkFloodProtection(
  env,
  userId,
  originalMessage
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  /*
   * Maximal 5 öffentliche Nachrichten
   * innerhalb von 10 Sekunden.
   */
  const recent =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS amount

      FROM chat_messages

      WHERE user_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
    `)
      .bind(
        userId,
        now -
        FLOOD_WINDOW_SECONDS
      )
      .first();

  if (
    Number(
      recent?.amount || 0
    ) >=
    FLOOD_MAX_MESSAGES
  ) {
    return {
      allowed:
        false,

      code:
        "FLOOD_LIMIT",

      error:
        "Du schreibst zu schnell. Bitte warte einen Moment."
    };
  }

  /*
   * Letzte eigene Nachricht laden.
   */
  const previous =
    await env.DB.prepare(`
      SELECT
        original_message,
        created_at

      FROM chat_messages

      WHERE user_id = ?
        AND deleted_at IS NULL

      ORDER BY
        created_at DESC,
        id DESC

      LIMIT 1
    `)
      .bind(
        userId
      )
      .first();

  if (
    previous?.original_message
  ) {
    const oldText =
      normalizeMessage(
        previous.original_message
      ).toLocaleLowerCase();

    const newText =
      normalizeMessage(
        originalMessage
      ).toLocaleLowerCase();

    /*
     * Direkt dieselbe Nachricht hintereinander
     * verhindern.
     */
    if (
      oldText &&
      oldText === newText
    ) {
      return {
        allowed:
          false,

        code:
          "DUPLICATE_MESSAGE",

        error:
          "Bitte sende nicht mehrfach dieselbe Nachricht."
      };
    }
  }

  return {
    allowed:
      true
  };
}

/*
 * =====================================================
 * MESSAGE LOOKUP
 * =====================================================
 */

async function getMessageById(
  env,
  messageId
) {
  return await env.DB.prepare(`
    SELECT
      m.id,
      m.user_id,
      m.room_type,
      m.server,
      m.message,
      m.original_message,
      m.reply_to,
      m.created_at,
      m.deleted_at,

      u.username,
      u.server
        AS user_server,
      u.role

    FROM chat_messages m

    JOIN users u
      ON u.id =
        m.user_id

    WHERE m.id = ?

    LIMIT 1
  `)
    .bind(
      messageId
    )
    .first();
}

/*
 * =====================================================
 * NORMAL MESSAGES
 * =====================================================
 */

async function loadNormalMessages(
  env,
  user,
  room,
  limit
) {
  let result;

  if (
    room.roomType ===
    "global"
  ) {
    result =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.room_type,
          m.server,
          m.message,
          m.reply_to,
          m.created_at,

          u.username,
          u.server
            AS user_server,
          u.role,

          r.id
            AS reply_id,

          r.message
            AS reply_message,

          ru.username
            AS reply_username,

          ru.role
            AS reply_role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        LEFT JOIN chat_messages r
          ON r.id =
            m.reply_to
          AND r.deleted_at
            IS NULL

        LEFT JOIN users ru
          ON ru.id =
            r.user_id

        WHERE m.room_type =
          'global'

          AND m.deleted_at
            IS NULL

          AND (
            u.role =
              'admin'

            OR NOT EXISTS (
              SELECT 1

              FROM chat_blocks b

              WHERE b.blocker_id = ?
                AND b.blocked_id =
                  m.user_id
            )
          )

        ORDER BY
          m.created_at DESC,
          m.id DESC

        LIMIT ?
      `)
        .bind(
          user.id,
          limit
        )
        .all();

  } else {
    result =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.room_type,
          m.server,
          m.message,
          m.reply_to,
          m.created_at,

          u.username,
          u.server
            AS user_server,
          u.role,

          r.id
            AS reply_id,

          r.message
            AS reply_message,

          ru.username
            AS reply_username,

          ru.role
            AS reply_role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        LEFT JOIN chat_messages r
          ON r.id =
            m.reply_to
          AND r.deleted_at
            IS NULL

        LEFT JOIN users ru
          ON ru.id =
            r.user_id

        WHERE m.room_type =
          'server'

          AND m.server = ?

          AND m.deleted_at
            IS NULL

          AND (
            u.role =
              'admin'

            OR NOT EXISTS (
              SELECT 1

              FROM chat_blocks b

              WHERE b.blocker_id = ?
                AND b.blocked_id =
                  m.user_id
            )
          )

        ORDER BY
          m.created_at DESC,
          m.id DESC

        LIMIT ?
      `)
        .bind(
          room.server,
          user.id,
          limit
        )
        .all();
  }

  return (
    result.results || []
  ).map(message => ({
    /*
     * V25:
     * expliziter Typ für das Frontend.
     */
    item_type:
      "message",

    type:
      "message",

    sort_id:
      Number(
        message.id
      ),

    id:
      message.id,

    user: {
      id:
        message.user_id,

      username:
        message.username,

      server:
        message.user_server,

      server_code:
        getServerCode(
          message.user_server,
          message.role
        ),

      role:
        message.role,

      is_admin:
        message.role ===
        "admin"
    },

    room: {
      type:
        message.room_type,

      server:
        message.server,

      server_code:
        message.server
          ? getServerCode(
              message.server
            )
          : null
    },

    message:
      message.message,

    reply_to:
      message.reply_id
        ? {
            id:
              message.reply_id,

            username:
              message.reply_username,

            message:
              message.reply_message,

            is_admin:
              message.reply_role ===
              "admin"
          }
        : null,

    created_at:
      message.created_at
  }));
}

/*
 * =====================================================
 * V25 SYSTEM MESSAGES
 * =====================================================
 */

async function loadSystemMessages(
  env,
  room,
  limit
) {
  let result;

  if (
    room.roomType ===
    "global"
  ) {
    result =
      await env.DB.prepare(`
        SELECT
          id,
          room_type,
          server,
          event_type,
          target_user_id,
          target_username,
          created_at

        FROM chat_system_messages

        WHERE room_type =
          'global'

        ORDER BY
          created_at DESC,
          id DESC

        LIMIT ?
      `)
        .bind(
          limit
        )
        .all();

  } else {
    result =
      await env.DB.prepare(`
        SELECT
          id,
          room_type,
          server,
          event_type,
          target_user_id,
          target_username,
          created_at

        FROM chat_system_messages

        WHERE room_type =
          'server'

          AND server = ?

        ORDER BY
          created_at DESC,
          id DESC

        LIMIT ?
      `)
        .bind(
          room.server,
          limit
        )
        .all();
  }

  return (
    result.results || []
  ).map(item => {
    let text;

    if (
      item.event_type ===
      "kick"
    ) {
      text =
        `${item.target_username} wurde aus dem Chat gekickt.`;
    } else {
      text =
        `${item.target_username} wurde aus dem Chat gebannt.`;
    }

    return {
      item_type:
        "system",

      type:
        "system",

      system:
        true,

      /*
       * Eigener String verhindert ID-Kollisionen
       * mit normalen Chatnachrichten.
       */
      id:
        `system-${item.id}`,

      system_id:
        item.id,

      sort_id:
        Number(
          item.id
        ),

      event_type:
        item.event_type,

      target_user_id:
        item.target_user_id,

      target_username:
        item.target_username,

      room: {
        type:
          item.room_type,

        server:
          item.server,

        server_code:
          item.server
            ? getServerCode(
                item.server
              )
            : null
      },

      message:
        text,

      created_at:
        item.created_at
    };
  });
}

/*
 * =====================================================
 * MERGE CHAT ITEMS
 * =====================================================
 */

function mergeChatItems(
  normalMessages,
  systemMessages,
  limit
) {
  return [
    ...normalMessages,
    ...systemMessages
  ]
    .sort(
      (a, b) => {
        const timeDifference =
          Number(
            a.created_at
          ) -
          Number(
            b.created_at
          );

        if (
          timeDifference !== 0
        ) {
          return timeDifference;
        }

        /*
         * Bei identischem Unix-Sekundenwert brauchen
         * wir lediglich eine stabile Reihenfolge.
         */
        if (
          a.item_type !==
          b.item_type
        ) {
          return a.item_type ===
            "message"
            ? -1
            : 1;
        }

        return (
          Number(
            a.sort_id || 0
          ) -
          Number(
            b.sort_id || 0
          )
        );
      }
    )
    .slice(
      -limit
    );
}

/*
 * =====================================================
 * GET
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
     * =================================================
     * V25:
     * BANN = KEIN LESEN
     * =================================================
     */
    const ban =
      await getActiveBan(
        env,
        user
      );

    if (ban) {
      /*
       * Sicherheitshalber Presence ebenfalls entfernen.
       */
      try {
        await env.DB.prepare(`
          DELETE FROM chat_presence

          WHERE user_id = ?
        `)
          .bind(
            user.id
          )
          .run();

      } catch (presenceError) {
        console.error(
          "Ban presence cleanup error:",
          presenceError
        );
      }

      return json(
        createBanResponse(
          ban
        ),
        403
      );
    }

    const url =
      new URL(
        request.url
      );

    const roomType =
      (
        url.searchParams.get(
          "room"
        ) ||
        "global"
      )
        .trim()
        .toLowerCase();

    const requestedServer =
      url.searchParams.get(
        "server"
      );

    const room =
      validateRoom(
        user,
        roomType,
        requestedServer
      );

    if (!room.ok) {
      return json({
        ok:
          false,

        error:
          room.error
      }, 400);
    }

    const limitRaw =
      Number(
        url.searchParams.get(
          "limit"
        ) ||
        DEFAULT_LIMIT
      );

    const limit =
      Number.isFinite(
        limitRaw
      )
        ? Math.max(
            1,
            Math.min(
              Math.floor(
                limitRaw
              ),
              MAX_LIMIT
            )
          )
        : DEFAULT_LIMIT;

    /*
     * Normale Nachrichten + Systemmeldungen separat
     * laden und danach chronologisch zusammenführen.
     */
    const [
      normalMessages,
      systemMessages
    ] =
      await Promise.all([
        loadNormalMessages(
          env,
          user,
          room,
          limit
        ),

        loadSystemMessages(
          env,
          room,
          limit
        )
      ]);

    const messages =
      mergeChatItems(
        normalMessages,
        systemMessages,
        limit
      );

    return json({
      ok:
        true,

      current_user: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        /*
         * Umbra/Admin:
         * ADMIN statt DE1.
         */
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

      room: {
        type:
          room.roomType,

        server:
          room.server,

        server_code:
          room.server
            ? getServerCode(
                room.server
              )
            : null,

        default_language:
          getRoomLanguage(
            room.roomType,
            room.server
          )
      },

      banned:
        false,

      ban:
        null,

      /*
       * Bestehender Feldname bleibt erhalten.
       *
       * V25 enthält darin sowohl:
       * - normale Nachrichten
       * - Systemmeldungen
       */
      messages,

      items:
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
        "Chat konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
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
      return json(
        createBanResponse(
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

    const roomType =
      typeof body.room ===
      "string"
        ? body.room
            .trim()
            .toLowerCase()
        : (
            typeof body.room_type ===
            "string"
              ? body.room_type
                  .trim()
                  .toLowerCase()
              : "global"
          );

    const requestedServer =
      typeof body.server ===
      "string"
        ? body.server.trim()
        : null;

    const room =
      validateRoom(
        user,
        roomType,
        requestedServer
      );

    if (!room.ok) {
      return json({
        ok:
          false,

        error:
          room.error
      }, 400);
    }

    const originalMessage =
      normalizeMessage(
        body.message
      );

    if (!originalMessage) {
      return json({
        ok:
          false,

        error:
          "Die Nachricht darf nicht leer sein."
      }, 400);
    }

    if (
      originalMessage.length >
      MESSAGE_MAX_LENGTH
    ) {
      return json({
        ok:
          false,

        error:
          `Eine Nachricht darf maximal ${MESSAGE_MAX_LENGTH} Zeichen enthalten.`
      }, 400);
    }

    /*
     * =================================================
     * FLOOD / DUPLICATE
     * =================================================
     */
    const flood =
      await checkFloodProtection(
        env,
        user.id,
        originalMessage
      );

    if (
      !flood.allowed
    ) {
      return json({
        ok:
          false,

        code:
          flood.code,

        error:
          flood.error
      }, 429);
    }

    /*
     * =================================================
     * REPLY
     * =================================================
     */
    let replyTo =
      null;

    if (
      body.reply_to !==
        null &&
      body.reply_to !==
        undefined &&
      body.reply_to !==
        ""
    ) {
      const replyId =
        toPositiveInt(
          body.reply_to
        );

      if (!replyId) {
        return json({
          ok:
            false,

          error:
            "Ungültige Antwort-Nachricht."
        }, 400);
      }

      const replyMessage =
        await getMessageById(
          env,
          replyId
        );

      if (
        !replyMessage ||
        replyMessage.deleted_at
      ) {
        return json({
          ok:
            false,

          error:
            "Die Nachricht, auf die du antworten möchtest, existiert nicht mehr."
        }, 404);
      }

      if (
        replyMessage.room_type !==
        room.roomType
      ) {
        return json({
          ok:
            false,

          error:
            "Du kannst nur auf Nachrichten aus demselben Chat antworten."
        }, 400);
      }

      if (
        room.roomType ===
          "server" &&
        replyMessage.server !==
          room.server
      ) {
        return json({
          ok:
            false,

          error:
            "Du kannst nur auf Nachrichten aus diesem Serverchat antworten."
        }, 400);
      }

      /*
       * Blockierte Nachricht darf kein verstecktes
       * Reply-Ziel sein.
       *
       * Admin ist davon ausgenommen.
       */
      if (
        replyMessage.role !==
        "admin"
      ) {
        const blocked =
          await env.DB.prepare(`
            SELECT 1

            FROM chat_blocks

            WHERE blocker_id = ?
              AND blocked_id = ?

            LIMIT 1
          `)
            .bind(
              user.id,
              replyMessage.user_id
            )
            .first();

        if (blocked) {
          return json({
            ok:
              false,

            error:
              "Auf diese Nachricht kannst du nicht antworten."
          }, 403);
        }
      }

      replyTo =
        replyId;
    }

    /*
     * =================================================
     * FILTER + SAVE
     * =================================================
     */

    const censoredMessage =
      censorMessage(
        originalMessage
      );

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const insert =
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

        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          user.id,
          room.roomType,
          room.server,
          censoredMessage,
          originalMessage,
          replyTo,
          now
        )
        .run();

    const messageId =
      insert?.meta
        ?.last_row_id ||
      null;

    return json({
      ok:
        true,

      message: {
        item_type:
          "message",

        type:
          "message",

        id:
          messageId,

        user: {
          id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          /*
           * Admin = ADMIN.
           */
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

        room: {
          type:
            room.roomType,

          server:
            room.server,

          server_code:
            room.server
              ? getServerCode(
                  room.server
                )
              : null
        },

        message:
          censoredMessage,

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
      await getMessageById(
        env,
        messageId
      );

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
     * Moderationslog.
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
 */

export async function onRequestPut() {
  return json({
    ok:
      false,

    error:
      "Chatnachrichten können nicht bearbeitet werden."
  }, 405);
}
