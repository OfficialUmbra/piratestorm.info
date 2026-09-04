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

async function getActiveBan(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  await cleanupExpiredBans(env);

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

async function ensureNotBanned(env, user) {
  const ban =
    await getActiveBan(
      env,
      user
    );

  if (!ban) {
    return {
      ok: true
    };
  }

  return {
    ok: false,

    response: json({
      ok: false,

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
          ban.expires_at,

        permanent:
          ban.expires_at === null
      }
    }, 403)
  };
}

async function isRoomMember(
  env,
  roomId,
  userId
) {
  const row =
    await env.DB.prepare(`
      SELECT 1 AS found
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

  return Boolean(row);
}

async function getRoom(
  env,
  roomId
) {
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

async function getLatestMessageId(
  env,
  roomId
) {
  const row =
    await env.DB.prepare(`
      SELECT id
      FROM whisper_messages
      WHERE room_id = ?
        AND deleted_at IS NULL
      ORDER BY
        created_at DESC,
        id DESC
      LIMIT 1
    `)
      .bind(roomId)
      .first();

  return row
    ? Number(row.id)
    : null;
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Liefert den aktuellen Read-State
 * des eingeloggten Nutzers für einen Raum.
 *
 * Beispiel:
 *
 * /api/chat/whisper-read?room_id=5
 */
export async function onRequestGet(context) {
  try {
    const { request, env } =
      context;

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

    const banCheck =
      await ensureNotBanned(
        env,
        user
      );

    if (!banCheck.ok) {
      return banCheck.response;
    }

    const url =
      new URL(request.url);

    const roomId =
      Number(
        url.searchParams.get(
          "room_id"
        )
      );

    if (
      !Number.isInteger(roomId) ||
      roomId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Whisper-Raum."
      }, 400);
    }

    const room =
      await getRoom(
        env,
        roomId
      );

    if (!room) {
      return json({
        ok: false,
        error:
          "Whisper-Raum wurde nicht gefunden."
      }, 404);
    }

    /*
     * WICHTIG:
     * Kein Admin-Bypass.
     *
     * Auch Admin darf Read-State eines privaten
     * Whisper-Raums nur lesen, wenn er Mitglied ist.
     */
    const member =
      await isRoomMember(
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

    const state =
      await env.DB.prepare(`
        SELECT
          last_read_message_id,
          updated_at
        FROM whisper_read_state
        WHERE room_id = ?
          AND user_id = ?
        LIMIT 1
      `)
        .bind(
          roomId,
          user.id
        )
        .first();

    const latestMessageId =
      await getLatestMessageId(
        env,
        roomId
      );

    return json({
      ok: true,

      room_id:
        roomId,

      last_read_message_id:
        state
          ? state.last_read_message_id
          : null,

      updated_at:
        state
          ? state.updated_at
          : null,

      latest_message_id:
        latestMessageId
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whisper-read error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Lesestatus konnte nicht geladen werden."
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
 * Das Frontend ruft diesen Endpoint auf,
 * wenn der Spieler den Raum tatsächlich öffnet.
 *
 * Body:
 *
 * {
 *   "room_id": 5
 * }
 *
 * Es wird immer bis zur aktuell letzten
 * existierenden Nachricht markiert.
 *
 * Der Client darf NICHT selbst irgendeine
 * fremde message_id bestimmen.
 */
export async function onRequestPost(context) {
  try {
    const { request, env } =
      context;

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

    const banCheck =
      await ensureNotBanned(
        env,
        user
      );

    if (!banCheck.ok) {
      return banCheck.response;
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
          "Ungültiger Whisper-Raum."
      }, 400);
    }

    const room =
      await getRoom(
        env,
        roomId
      );

    if (!room) {
      return json({
        ok: false,
        error:
          "Whisper-Raum wurde nicht gefunden."
      }, 404);
    }

    /*
     * Wieder keinerlei Admin-Sonderrecht.
     */
    const member =
      await isRoomMember(
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

    const latestMessageId =
      await getLatestMessageId(
        env,
        roomId
      );

    const now =
      Math.floor(Date.now() / 1000);

    /*
     * Auch ein komplett leerer Raum bekommt einen
     * Read-State. last_read_message_id ist dann NULL.
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

/*
 * =====================================================
 * PUT / DELETE
 * =====================================================
 *
 * Nicht benötigt.
 *
 * Der Read-State wird ausschließlich vom
 * eingeloggten Nutzer für eigene Whisper-Räume
 * per POST aktualisiert.
 */
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
