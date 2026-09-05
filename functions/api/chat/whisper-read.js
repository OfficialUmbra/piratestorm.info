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
      ON users.id =
        sessions.user_id

    WHERE sessions.id = ?
      AND sessions.expires_at > ?

    LIMIT 1
  `)
    .bind(
      token,
      Math.floor(
        Date.now() / 1000
      )
    )
    .first();
}

async function isRoomMember(
  env,
  roomId,
  userId
) {
  return await env.DB.prepare(`
    SELECT
      room_id,
      user_id

    FROM whisper_members

    WHERE room_id = ?
      AND user_id = ?

    LIMIT 1
  `)
    .bind(
      roomId,
      userId
    )
    .first();
}

async function getLatestMessageId(
  env,
  roomId
) {
  const latest =
    await env.DB.prepare(`
      SELECT id

      FROM whisper_messages

      WHERE room_id = ?

      ORDER BY
        id DESC

      LIMIT 1
    `)
      .bind(roomId)
      .first();

  return latest
    ? latest.id
    : null;
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Liefert für den eingeloggten Spieler die Anzahl
 * ungelesener Whisper-Nachrichten.
 *
 * Nur Whisper-Räume, in denen der Spieler wirklich
 * Mitglied ist, werden berücksichtigt.
 *
 * Admin hat KEINEN Sonderzugriff auf fremde
 * Whisper-Räume.
 *
 * Beispiele:
 *
 * GET /api/chat/whisper-read
 *
 * Antwort:
 *
 * {
 *   "ok": true,
 *   "total_unread": 4,
 *   "rooms": [
 *     {
 *       "room_id": 1,
 *       "unread": 3
 *     },
 *     {
 *       "room_id": 5,
 *       "unread": 1
 *     }
 *   ]
 * }
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

    /*
     * Alle Whisper-Räume laden,
     * in denen der Spieler Mitglied ist.
     */
    const memberships =
      await env.DB.prepare(`
        SELECT
          wr.id AS room_id,
          wr.name,
          wr.created_at,

          wrs.last_read_message_id,
          wrs.updated_at

        FROM whisper_members wm

        JOIN whisper_rooms wr
          ON wr.id =
            wm.room_id

        LEFT JOIN whisper_read_state wrs
          ON wrs.room_id =
            wm.room_id
          AND wrs.user_id = ?

        WHERE wm.user_id = ?

        ORDER BY
          wr.created_at DESC
      `)
        .bind(
          user.id,
          user.id
        )
        .all();

    const rooms = [];

    let totalUnread = 0;

    for (
      const membership
      of memberships.results || []
    ) {
      const roomId =
        membership.room_id;

      /*
       * Wenn noch nie ein Read-State existierte,
       * zählen alle vorhandenen Nachrichten anderer
       * Spieler als ungelesen.
       *
       * Eigene Nachrichten zählen niemals als
       * ungelesen.
       */
      let query = `
        SELECT
          COUNT(*) AS unread

        FROM whisper_messages

        WHERE room_id = ?
          AND user_id != ?
          AND deleted_at IS NULL
      `;

      const bindings = [
        roomId,
        user.id
      ];

      if (
        membership.last_read_message_id !== null &&
        membership.last_read_message_id !== undefined
      ) {
        query += `
          AND id > ?
        `;

        bindings.push(
          membership.last_read_message_id
        );
      }

      const unreadResult =
        await env.DB
          .prepare(query)
          .bind(...bindings)
          .first();

      const unread =
        Number(
          unreadResult?.unread || 0
        );

      totalUnread += unread;

      rooms.push({
        room_id:
          roomId,

        name:
          membership.name || null,

        unread,

        last_read_message_id:
          membership.last_read_message_id ===
            null ||
          membership.last_read_message_id ===
            undefined
            ? null
            : membership.last_read_message_id,

        updated_at:
          membership.updated_at || null
      });
    }

    return json({
      ok: true,

      total_unread:
        totalUnread,

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
 * Markiert einen Whisper-Raum als gelesen.
 *
 * Erwartet:
 *
 * {
 *   "room_id": 5
 * }
 *
 * Der Read-State wird auf die aktuell neueste
 * Nachricht dieses Raumes gesetzt.
 *
 * Wichtig:
 *
 * Auch Admins dürfen nur Räume als gelesen markieren,
 * in denen sie tatsächlich Mitglied sind.
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

    const roomId =
      Number(
        body.room_id
      );

    if (
      !Number.isInteger(roomId) ||
      roomId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Whisper-Chat."
      }, 400);
    }

    /*
     * Kein Admin-Bypass.
     *
     * Der Spieler muss echtes Mitglied
     * des Whisper-Raumes sein.
     */
    const membership =
      await isRoomMember(
        env,
        roomId,
        user.id
      );

    if (!membership) {
      return json({
        ok: false,
        error:
          "Du bist kein Mitglied dieses Whisper-Chats."
      }, 403);
    }

    const latestMessageId =
      await getLatestMessageId(
        env,
        roomId
      );

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Wenn der Raum noch keine Nachrichten besitzt,
     * wird last_read_message_id = NULL gespeichert.
     *
     * Ansonsten wird die neueste Nachricht als
     * gelesen markiert.
     */
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

      unread:
        0,

      updated_at:
        now,

      message:
        "Whisper-Chat wurde als gelesen markiert."
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

/*
 * =====================================================
 * PUT / DELETE
 * =====================================================
 *
 * Nicht benötigt.
 */
export async function onRequestPut() {
  return json({
    ok: false,
    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,
    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}
