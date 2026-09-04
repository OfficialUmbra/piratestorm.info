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
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(token, Math.floor(Date.now() / 1000))
    .first();
}

function isAdmin(user) {
  return user && user.role === "admin";
}

function getServerCode(server) {
  return SERVER_MAP[server] || server;
}

function getRoomLanguage(roomType, server) {
  if (roomType === "global") {
    return "en";
  }

  if (server === "Deutschland 1") {
    return "de";
  }

  return "en";
}

async function getActiveBan(env, userId) {
  const now = Math.floor(Date.now() / 1000);

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
    ORDER BY banned_at DESC
    LIMIT 1
  `)
    .bind(userId, now)
    .first();
}

async function cleanExpiredBans(env, userId) {
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    UPDATE chat_bans
    SET active = 0
    WHERE user_id = ?
      AND active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(userId, now)
    .run();
}

function validateRoom(user, roomType, requestedServer) {
  if (roomType === "global") {
    return {
      ok: true,
      roomType: "global",
      server: null
    };
  }

  if (roomType !== "server") {
    return {
      ok: false,
      error: "Ungültiger Chatraum."
    };
  }

  // Admins dürfen jeden existierenden Serverchat betreten.
  if (isAdmin(user)) {
    const server = requestedServer || user.server;

    if (!SERVER_MAP[server]) {
      return {
        ok: false,
        error: "Ungültiger Server."
      };
    }

    return {
      ok: true,
      roomType: "server",
      server
    };
  }

  // Normale Nutzer können niemals einen fremden Server auswählen.
  return {
    ok: true,
    roomType: "server",
    server: user.server
  };
}

function normalizeMessage(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/*
 * Erste Basis für den Wortfilter.
 *
 * WICHTIG:
 * Der echte Originaltext wird weiterhin in original_message gespeichert.
 * message enthält die öffentlich sichtbare, gefilterte Version.
 *
 * Die Liste erweitern wir später gemeinsam deutlich.
 */
function censorMessage(text) {
  const blockedWords = [
    "arschloch",
    "hurensohn",
    "wichser",
    "fotze",
    "missgeburt"
  ];

  let result = text;

  for (const word of blockedWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "giu");

    result = result.replace(regex, match => "*".repeat(match.length));
  }

  return result;
}

async function checkFloodProtection(env, userId) {
  const now = Math.floor(Date.now() / 1000);

  // Maximal 5 Nachrichten innerhalb von 10 Sekunden.
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS amount
    FROM chat_messages
    WHERE user_id = ?
      AND created_at >= ?
      AND deleted_at IS NULL
  `)
    .bind(userId, now - 10)
    .first();

  if (Number(result?.amount || 0) >= 5) {
    return {
      allowed: false,
      error: "Du schreibst zu schnell. Bitte warte einen Moment."
    };
  }

  // Verhindert mehrfaches direktes Spammen derselben Nachricht.
  const lastMessage = await env.DB.prepare(`
    SELECT original_message
    FROM chat_messages
    WHERE user_id = ?
      AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
    .bind(userId)
    .first();

  return {
    allowed: true,
    lastMessage: lastMessage?.original_message || null
  };
}

async function getMessageById(env, messageId) {
  return await env.DB.prepare(`
    SELECT
      chat_messages.id,
      chat_messages.user_id,
      chat_messages.room_type,
      chat_messages.server,
      chat_messages.message,
      chat_messages.original_message,
      chat_messages.reply_to,
      chat_messages.created_at,
      chat_messages.deleted_at,
      users.username,
      users.server AS user_server,
      users.role
    FROM chat_messages
    JOIN users ON users.id = chat_messages.user_id
    WHERE chat_messages.id = ?
    LIMIT 1
  `)
    .bind(messageId)
    .first();
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

    await cleanExpiredBans(env, user.id);

    const ban = await getActiveBan(env, user.id);

    const url = new URL(request.url);

    const roomType = url.searchParams.get("room") || "global";
    const requestedServer = url.searchParams.get("server");

    const room = validateRoom(user, roomType, requestedServer);

    if (!room.ok) {
      return json({
        ok: false,
        error: room.error
      }, 400);
    }

    const limitRaw = Number(url.searchParams.get("limit") || 100);
    const limit = Math.max(1, Math.min(limitRaw, 200));

    let query;
    let bindings;

    if (room.roomType === "global") {
      query = `
        SELECT
          m.id,
          m.user_id,
          m.room_type,
          m.server,
          m.message,
          m.reply_to,
          m.created_at,

          u.username,
          u.server AS user_server,
          u.role,

          r.id AS reply_id,
          r.message AS reply_message,
          ru.username AS reply_username

        FROM chat_messages m

        JOIN users u
          ON u.id = m.user_id

        LEFT JOIN chat_messages r
          ON r.id = m.reply_to
          AND r.deleted_at IS NULL

        LEFT JOIN users ru
          ON ru.id = r.user_id

        WHERE m.room_type = 'global'
          AND m.deleted_at IS NULL

          AND NOT EXISTS (
            SELECT 1
            FROM chat_blocks b
            WHERE b.blocker_id = ?
              AND b.blocked_id = m.user_id
          )

        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      `;

      bindings = [user.id, limit];
    } else {
      query = `
        SELECT
          m.id,
          m.user_id,
          m.room_type,
          m.server,
          m.message,
          m.reply_to,
          m.created_at,

          u.username,
          u.server AS user_server,
          u.role,

          r.id AS reply_id,
          r.message AS reply_message,
          ru.username AS reply_username

        FROM chat_messages m

        JOIN users u
          ON u.id = m.user_id

        LEFT JOIN chat_messages r
          ON r.id = m.reply_to
          AND r.deleted_at IS NULL

        LEFT JOIN users ru
          ON ru.id = r.user_id

        WHERE m.room_type = 'server'
          AND m.server = ?
          AND m.deleted_at IS NULL

          AND NOT EXISTS (
            SELECT 1
            FROM chat_blocks b
            WHERE b.blocker_id = ?
              AND b.blocked_id = m.user_id
          )

        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      `;

      bindings = [room.server, user.id, limit];
    }

    const result = await env.DB.prepare(query)
      .bind(...bindings)
      .all();

    const messages = (result.results || [])
      .reverse()
      .map(message => ({
        id: message.id,

        user: {
          id: message.user_id,
          username: message.username,
          server: message.user_server,
          server_code: getServerCode(message.user_server),
          role: message.role,
          is_admin: message.role === "admin"
        },

        room: {
          type: message.room_type,
          server: message.server,
          server_code: message.server
            ? getServerCode(message.server)
            : null
        },

        message: message.message,

        reply_to: message.reply_id
          ? {
              id: message.reply_id,
              username: message.reply_username,
              message: message.reply_message
            }
          : null,

        created_at: message.created_at
      }));

    return json({
      ok: true,

      current_user: {
        id: user.id,
        username: user.username,
        server: user.server,
        server_code: getServerCode(user.server),
        role: user.role,
        is_admin: isAdmin(user)
      },

      room: {
        type: room.roomType,
        server: room.server,
        server_code: room.server
          ? getServerCode(room.server)
          : null,

        default_language: getRoomLanguage(
          room.roomType,
          room.server
        )
      },

      banned: Boolean(ban),

      ban: ban
        ? {
            reason: ban.reason || null,
            banned_at: ban.banned_at,
            expires_at: ban.expires_at,
            permanent: ban.expires_at === null
          }
        : null,

      messages
    });
  } catch (error) {
    console.error(error);

    return json({
      ok: false,
      error: "Chat konnte nicht geladen werden."
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

    await cleanExpiredBans(env, user.id);

    const ban = await getActiveBan(env, user.id);

    if (ban) {
      return json({
        ok: false,
        error: "Du bist derzeit vom Chat ausgeschlossen.",
        ban: {
          reason: ban.reason || null,
          expires_at: ban.expires_at,
          permanent: ban.expires_at === null
        }
      }, 403);
    }

    const body = await request.json();

    const roomType = body.room || "global";
    const requestedServer = body.server || null;

    const room = validateRoom(
      user,
      roomType,
      requestedServer
    );

    if (!room.ok) {
      return json({
        ok: false,
        error: room.error
      }, 400);
    }

    const originalMessage = normalizeMessage(body.message);

    if (!originalMessage) {
      return json({
        ok: false,
        error: "Die Nachricht darf nicht leer sein."
      }, 400);
    }

    if (originalMessage.length > 500) {
      return json({
        ok: false,
        error: "Eine Nachricht darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    const flood = await checkFloodProtection(env, user.id);

    if (!flood.allowed) {
      return json({
        ok: false,
        error: flood.error
      }, 429);
    }

    if (
      flood.lastMessage &&
      flood.lastMessage.trim().toLowerCase() ===
        originalMessage.trim().toLowerCase()
    ) {
      return json({
        ok: false,
        error: "Bitte sende nicht mehrfach dieselbe Nachricht."
      }, 429);
    }

    let replyTo = null;

    if (
      body.reply_to !== null &&
      body.reply_to !== undefined &&
      body.reply_to !== ""
    ) {
      const replyId = Number(body.reply_to);

      if (!Number.isInteger(replyId) || replyId <= 0) {
        return json({
          ok: false,
          error: "Ungültige Antwort-Nachricht."
        }, 400);
      }

      const replyMessage = await getMessageById(
        env,
        replyId
      );

      if (!replyMessage || replyMessage.deleted_at) {
        return json({
          ok: false,
          error: "Die Nachricht, auf die du antworten möchtest, existiert nicht mehr."
        }, 404);
      }

      if (replyMessage.room_type !== room.roomType) {
        return json({
          ok: false,
          error: "Du kannst nur auf Nachrichten aus demselben Chat antworten."
        }, 400);
      }

      if (
        room.roomType === "server" &&
        replyMessage.server !== room.server
      ) {
        return json({
          ok: false,
          error: "Du kannst nur auf Nachrichten aus diesem Serverchat antworten."
        }, 400);
      }

      replyTo = replyId;
    }

    const censoredMessage = censorMessage(originalMessage);
    const now = Math.floor(Date.now() / 1000);

    const insert = await env.DB.prepare(`
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

    const messageId = insert.meta.last_row_id;

    return json({
      ok: true,

      message: {
        id: messageId,

        user: {
          id: user.id,
          username: user.username,
          server: user.server,
          server_code: getServerCode(user.server),
          role: user.role,
          is_admin: isAdmin(user)
        },

        room: {
          type: room.roomType,
          server: room.server,
          server_code: room.server
            ? getServerCode(room.server)
            : null,

          default_language: getRoomLanguage(
            room.roomType,
            room.server
          )
        },

        message: censoredMessage,
        reply_to: replyTo,
        created_at: now
      }
    }, 201);
  } catch (error) {
    console.error(error);

    return json({
      ok: false,
      error: "Nachricht konnte nicht gesendet werden."
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

    if (!isAdmin(user)) {
      return json({
        ok: false,
        error: "Nur der Administrator darf Chatnachrichten löschen."
      }, 403);
    }

    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));

    if (!Number.isInteger(id) || id <= 0) {
      return json({
        ok: false,
        error: "Ungültige Nachrichten-ID."
      }, 400);
    }

    const target = await getMessageById(env, id);

    if (!target || target.deleted_at) {
      return json({
        ok: false,
        error: "Nachricht nicht gefunden."
      }, 404);
    }

    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      UPDATE chat_messages
      SET deleted_at = ?
      WHERE id = ?
    `)
      .bind(now, id)
      .run();

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
        target.user_id,
        "delete_message",
        JSON.stringify({
          message_id: target.id,
          room_type: target.room_type,
          server: target.server,
          original_message: target.original_message
        }),
        now
      )
      .run();

    return json({
      ok: true,
      message: "Nachricht wurde gelöscht."
    });
  } catch (error) {
    console.error(error);

    return json({
      ok: false,
      error: "Nachricht konnte nicht gelöscht werden."
    }, 500);
  }
}
