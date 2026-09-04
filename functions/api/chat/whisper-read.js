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
  return Boolean(user && user.role === "admin");
}

async function cleanupExpiredBans(env) {
  const now = Math.floor(Date.now() / 1000);

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

async function getActiveBan(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  await cleanupExpiredBans(env);

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
    ORDER BY banned_at DESC, id DESC
    LIMIT 1
  `)
    .bind(user.id, now)
    .first();
}

async function ensureNotBanned(env, user) {
  const ban = await getActiveBan(env, user);

  if (!ban) {
    return { ok: true };
  }

  return {
    ok: false,
    response: json({
      ok: false,
      error: "Du bist derzeit vom Chat ausgeschlossen.",
      ban: {
        id: ban.id,
        reason: ban.reason || null,
        banned_at: ban.banned_at,
        expires_at: ban.expires_at,
        permanent: ban.expires_at === null
      }
    }, 403)
  };
}

async function isRoomMember(env, roomId, userId) {
  const member = await env.DB.prepare(`
    SELECT 1 AS found
    FROM whisper_members
    WHERE room_id = ?
      AND user_id = ?
    LIMIT 1
  `)
    .bind(roomId, userId)
    .first();

  return Boolean(member);
}

async function getRoom(env, roomId) {
  return await env.DB.prepare(`
    SELECT
      id,
      created_by,
      name,
      created_at
    FROM whisper_rooms
    WHERE id = ?
    LIMIT 1
  `)
    .bind(roomId)
    .first();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Ohne room_id:
 * Liefert die Unread-Zähler ALLER eigenen Whisper-Räume.
 *
 * GET /api/chat/whisper-read
 *
 *
 * Mit room_id:
 * Liefert den Read-State eines einzelnen eigenen Raums.
 *
 * GET /api/chat/whisper-read?room_id=5
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

    const banCheck = await ensureNotBanned(env, user);

    if (!banCheck.ok) {
      return banCheck.response;
    }

    const url = new URL(request.url);
    const roomIdRaw = url.searchParams.get("room_id");

    /*
     * =================================================
     * EINZELNER RAUM
     * =================================================
     */
    if (roomIdRaw !== null) {
      const roomId = Number(roomIdRaw);

      if (!Number.isInteger(roomId) || roomId <= 0) {
        return json({
          ok: false,
          error: "Ungültiger Whisper-Raum."
        }, 400);
      }

      const room = await getRoom(env, roomId);

      if (!room) {
        return json({
          ok: false,
          error: "Whisper-Raum wurde nicht gefunden."
        }, 404);
      }

      /*
       * Kein Admin-Bypass.
       *
       * Auch Admin darf einen privaten Whisper-Raum
       * nur auslesen, wenn er wirklich Mitglied ist.
       */
      const member = await isRoomMember(
        env,
        roomId,
        user.id
      );

      if (!member) {
        return json({
          ok: false,
          error:
            "Du hast keinen Zugriff auf diesen Whisper-Chat."
        }, 403);
      }

      const state = await env.DB.prepare(`
        SELECT
          last_read_message_id,
          updated_at
        FROM whisper_read_state
        WHERE room_id = ?
          AND user_id = ?
        LIMIT 1
      `)
        .bind(roomId, user.id)
        .first();

      /*
       * Nur Nachrichten ANDERER Spieler zählen.
       *
       * Gelöschte Nachrichten zählen nicht.
       */
      const unreadRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM whisper_messages wm
        WHERE wm.room_id = ?
          AND wm.user_id != ?
          AND wm.deleted_at IS NULL
          AND wm.id > COALESCE(?, 0)
      `)
        .bind(
          roomId,
          user.id,
          state?.last_read_message_id ?? null
        )
        .first();

      const latestRow = await env.DB.prepare(`
        SELECT id
        FROM whisper_messages
        WHERE room_id = ?
          AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `)
        .bind(roomId)
        .first();

      return json({
        ok: true,

        room_id: roomId,

        last_read_message_id:
          state?.last_read_message_id ?? null,

        updated_at:
          state?.updated_at ?? null,

        latest_message_id:
          latestRow?.id ?? null,

        unread:
          Number(unreadRow?.total || 0)
      });
    }

    /*
     * =================================================
     * ALLE EIGENEN WHISPER-RÄUME
     * =================================================
     *
     * Eine Query reicht für alle Zähler.
     *
     * Wichtig:
     * - nur eigene Räume
     * - eigene Nachrichten zählen nicht
     * - gelöschte Nachrichten zählen nicht
     * - Nachrichten nach last_read_message_id zählen
     */
    const result = await env.DB.prepare(`
      SELECT
        wr.id AS room_id,
        wr.name AS room_name,

        wrs.last_read_message_id,
        wrs.updated_at,

        (
          SELECT MAX(wm_latest.id)
          FROM whisper_messages wm_latest
          WHERE wm_latest.room_id = wr.id
            AND wm_latest.deleted_at IS NULL
        ) AS latest_message_id,

        (
          SELECT COUNT(*)
          FROM whisper_messages wm_unread
          WHERE wm_unread.room_id = wr.id
            AND wm_unread.user_id != ?
            AND wm_unread.deleted_at IS NULL
            AND wm_unread.id >
              COALESCE(
                wrs.last_read_message_id,
                0
              )
        ) AS unread

      FROM whisper_rooms wr

      JOIN whisper_members member
        ON member.room_id = wr.id
       AND member.user_id = ?

      LEFT JOIN whisper_read_state wrs
        ON wrs.room_id = wr.id
       AND wrs.user_id = ?

      ORDER BY wr.created_at DESC
    `)
      .bind(
        user.id,
        user.id,
        user.id
      )
      .all();

    const rooms = (result.results || []).map(row => ({
      room_id: row.room_id,
      room_name: row.room_name || null,

      last_read_message_id:
        row.last_read_message_id ?? null,

      latest_message_id:
        row.latest_message_id ?? null,

      updated_at:
        row.updated_at ?? null,

      unread:
        Number(row.unread || 0)
    }));

    const totalUnread = rooms.reduce(
      (sum, room) => sum + room.unread,
      0
    );

    return json({
      ok: true,

      total_unread: totalUnread,

      rooms
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whisper-read error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die ungelesenen Whisper-Nachrichten konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Markiert einen Whisper-Raum bis zur aktuell
 * letzten Nachricht als gelesen.
 *
 * POST /api/chat/whisper-read
 *
 * {
 *   "room_id": 5
 * }
 *
 * Der Client bestimmt NICHT selbst die message_id.
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

    const banCheck = await ensureNotBanned(env, user);

    if (!banCheck.ok) {
      return banCheck.response;
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

    const roomId = Number(body.room_id);

    if (!Number.isInteger(roomId) || roomId <= 0) {
      return json({
        ok: false,
        error: "Ungültiger Whisper-Raum."
      }, 400);
    }

    const room = await getRoom(env, roomId);

    if (!room) {
      return json({
        ok: false,
        error: "Whisper-Raum wurde nicht gefunden."
      }, 404);
    }

    /*
     * Auch hier KEIN Admin-Bypass.
     */
    const member = await isRoomMember(
      env,
      roomId,
      user.id
    );

    if (!member) {
      return json({
        ok: false,
        error:
          "Du hast keinen Zugriff auf diesen Whisper-Chat."
      }, 403);
    }

    /*
     * Wir nehmen absichtlich die letzte Nachricht
     * des Servers.
     *
     * Der Browser darf keine beliebige message_id
     * als "gelesen" setzen.
     */
    const latestRow = await env.DB.prepare(`
      SELECT id
      FROM whisper_messages
      WHERE room_id = ?
        AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(roomId)
      .first();

    const latestMessageId =
      latestRow?.id ?? null;

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      INSERT INTO whisper_read_state (
        room_id,
        user_id,
        last_read_message_id,
        updated_at
      )
      VALUES (?, ?, ?, ?)

      ON CONFLICT(room_id, user_id)
      DO UPDATE SET
        last_read_message_id =
          excluded.last_read_message_id,
        updated_at =
          excluded.updated_at
    `)
      .bind(
        roomId,
        user.id,
        latestMessageId,
        now
      )
      .run();

    return json({
      ok: true,

      room_id:
        roomId,

      last_read_message_id:
        latestMessageId,

      updated_at:
        now,

      unread:
        0
    });

  } catch (error) {
    console.error(
      "POST /api/chat/whisper-read error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Whisper-Chat konnte nicht als gelesen markiert werden."
    }, 500);
  }
}

export async function onRequestPut() {
  return json({
    ok: false,
    error:
      "Diese Aktion wird nicht unterstützt."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,
    error:
      "Diese Aktion wird nicht unterstützt."
  }, 405);
}
