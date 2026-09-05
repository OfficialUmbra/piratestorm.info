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
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();

    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) continue;

    const key = trimmed
      .slice(0, separatorIndex)
      .trim();

    const value = trimmed
      .slice(separatorIndex + 1)
      .trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(
    request,
    "ps_session"
  );

  if (!sessionId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  const user = await env.DB.prepare(`
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
    .bind(sessionId, now)
    .first();

  return user || null;
}

function isAdmin(user) {
  return user?.role === "admin";
}

async function expireOldBans(env) {
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    UPDATE forum_bans
    SET active = 0
    WHERE active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(now)
    .run();
}

async function getActiveBan(env, userId) {
  await expireOldBans(env);

  const now = Math.floor(Date.now() / 1000);

  const ban = await env.DB.prepare(`
    SELECT
      forum_bans.id,
      forum_bans.user_id,
      forum_bans.banned_by,
      forum_bans.reason,
      forum_bans.banned_at,
      forum_bans.expires_at,
      forum_bans.active,
      admin.username AS banned_by_username
    FROM forum_bans
    LEFT JOIN users AS admin
      ON admin.id = forum_bans.banned_by
    WHERE forum_bans.user_id = ?
      AND forum_bans.active = 1
      AND (
        forum_bans.expires_at IS NULL
        OR forum_bans.expires_at > ?
      )
    ORDER BY forum_bans.banned_at DESC
    LIMIT 1
  `)
    .bind(userId, now)
    .first();

  return ban || null;
}

function durationToSeconds(duration) {
  const durations = {
    "10m": 10 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "6h": 6 * 60 * 60,
    "24h": 24 * 60 * 60,
    "7d": 7 * 24 * 60 * 60
  };

  return durations[duration] ?? null;
}

function serializeBan(ban) {
  if (!ban) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  let remainingSeconds = null;

  if (ban.expires_at !== null) {
    remainingSeconds = Math.max(
      0,
      Number(ban.expires_at) - now
    );
  }

  return {
    id: Number(ban.id),
    user_id: Number(ban.user_id),
    reason: ban.reason || "",
    banned_at: Number(ban.banned_at),
    expires_at:
      ban.expires_at === null
        ? null
        : Number(ban.expires_at),

    permanent:
      ban.expires_at === null,

    remaining_seconds:
      remainingSeconds,

    banned_by_username:
      ban.banned_by_username || null
  };
}

/*
  GET

  Normaler Nutzer:
  /api/forum/bans

  -> gibt nur den eigenen Bannstatus zurück.

  Admin:
  /api/forum/bans?user_id=123

  -> darf den Bannstatus eines bestimmten
     normalen Nutzers prüfen.
*/
export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    if (!currentUser) {
      return json(
        {
          ok: false,
          error: "Not logged in."
        },
        401
      );
    }

    await expireOldBans(env);

    const url = new URL(request.url);

    const requestedUserId =
      Number(
        url.searchParams.get("user_id")
      );

    let targetUserId =
      Number(currentUser.id);

    if (
      Number.isInteger(requestedUserId) &&
      requestedUserId > 0
    ) {
      if (!isAdmin(currentUser)) {
        return json(
          {
            ok: false,
            error: "Admin access required."
          },
          403
        );
      }

      targetUserId =
        requestedUserId;
    }

    const targetUser =
      await env.DB.prepare(`
        SELECT
          id,
          username,
          server,
          role
        FROM users
        WHERE id = ?
        LIMIT 1
      `)
        .bind(targetUserId)
        .first();

    if (!targetUser) {
      return json(
        {
          ok: false,
          error: "User not found."
        },
        404
      );
    }

    /*
      Admin-Accounts können niemals einen
      aktiven Forum-Bann haben.

      Falls durch eine alte/fehlerhafte
      Datenbankoperation doch einer existiert,
      wird er deaktiviert.
    */
    if (isAdmin(targetUser)) {
      await env.DB.prepare(`
        UPDATE forum_bans
        SET active = 0
        WHERE user_id = ?
          AND active = 1
      `)
        .bind(targetUser.id)
        .run();

      return json({
        ok: true,

        user: {
          id: Number(targetUser.id),
          username: targetUser.username,
          server:
            targetUser.role === "admin"
              ? "ADMIN"
              : targetUser.server,
          role: targetUser.role
        },

        banned: false,
        ban: null,
        protected: true
      });
    }

    const ban =
      await getActiveBan(
        env,
        targetUser.id
      );

    return json({
      ok: true,

      user: {
        id: Number(targetUser.id),
        username: targetUser.username,
        server: targetUser.server,
        role: targetUser.role
      },

      banned: Boolean(ban),
      ban: serializeBan(ban),
      protected: false
    });
  } catch (error) {
    console.error(
      "Forum bans GET error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

/*
  POST

  Admin erstellt einen Forum-Bann.

  JSON:
  {
    "user_id": 123,
    "duration": "24h",
    "reason": "Spam"
  }

  duration:
  10m
  30m
  1h
  6h
  24h
  7d
  permanent
*/
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    if (!currentUser) {
      return json(
        {
          ok: false,
          error: "Not logged in."
        },
        401
      );
    }

    if (!isAdmin(currentUser)) {
      return json(
        {
          ok: false,
          error: "Admin access required."
        },
        403
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON."
        },
        400
      );
    }

    const userId =
      Number(body?.user_id);

    const duration =
      String(
        body?.duration || ""
      ).trim();

    const reason =
      String(
        body?.reason || ""
      )
        .trim()
        .slice(0, 1000);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return json(
        {
          ok: false,
          error: "Invalid user_id."
        },
        400
      );
    }

    const allowedDurations =
      new Set([
        "10m",
        "30m",
        "1h",
        "6h",
        "24h",
        "7d",
        "permanent"
      ]);

    if (
      !allowedDurations.has(duration)
    ) {
      return json(
        {
          ok: false,
          error: "Invalid duration."
        },
        400
      );
    }

    if (reason.length < 3) {
      return json(
        {
          ok: false,
          error:
            "A reason with at least 3 characters is required."
        },
        400
      );
    }

    const targetUser =
      await env.DB.prepare(`
        SELECT
          id,
          username,
          server,
          role
        FROM users
        WHERE id = ?
        LIMIT 1
      `)
        .bind(userId)
        .first();

    if (!targetUser) {
      return json(
        {
          ok: false,
          error: "User not found."
        },
        404
      );
    }

    /*
      Ganz wichtig:
      Admins sind serverseitig geschützt.
    */
    if (isAdmin(targetUser)) {
      return json(
        {
          ok: false,
          error:
            "Administrator accounts cannot be forum banned."
        },
        403
      );
    }

    if (
      Number(targetUser.id) ===
      Number(currentUser.id)
    ) {
      return json(
        {
          ok: false,
          error:
            "You cannot forum ban yourself."
        },
        403
      );
    }

    await expireOldBans(env);

    /*
      Vorhandenen aktiven Bann deaktivieren.

      Dadurch gibt es pro Nutzer immer nur
      einen aktuellen Forum-Bann.
    */
    await env.DB.prepare(`
      UPDATE forum_bans
      SET active = 0
      WHERE user_id = ?
        AND active = 1
    `)
      .bind(userId)
      .run();

    const now =
      Math.floor(Date.now() / 1000);

    let expiresAt = null;

    if (duration !== "permanent") {
      expiresAt =
        now +
        durationToSeconds(duration);
    }

    const result =
      await env.DB.prepare(`
        INSERT INTO forum_bans (
          user_id,
          banned_by,
          reason,
          banned_at,
          expires_at,
          active
        )
        VALUES (?, ?, ?, ?, ?, 1)
      `)
        .bind(
          userId,
          currentUser.id,
          reason,
          now,
          expiresAt
        )
        .run();

    /*
      Moderationslog benutzen wir,
      falls die Tabelle vorhanden ist.

      Sie existiert bei unserem aktuellen
      PirateStorm.info-Setup bereits.
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
          currentUser.id,
          userId,
          "forum_ban",
          JSON.stringify({
            duration,
            reason,
            expires_at: expiresAt
          }),
          now
        )
        .run();
    } catch (logError) {
      console.error(
        "Forum ban moderation log error:",
        logError
      );
    }

    const newBan =
      await getActiveBan(
        env,
        userId
      );

    return json({
      ok: true,

      message:
        `${targetUser.username} was forum banned.`,

      user: {
        id: Number(targetUser.id),
        username: targetUser.username,
        server: targetUser.server
      },

      banned: true,
      ban: serializeBan(newBan),

      ban_id:
        result?.meta?.last_row_id ||
        newBan?.id ||
        null
    });
  } catch (error) {
    console.error(
      "Forum bans POST error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

/*
  DELETE

  Admin hebt einen Forum-Bann auf.

  JSON:
  {
    "user_id": 123
  }
*/
export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    if (!currentUser) {
      return json(
        {
          ok: false,
          error: "Not logged in."
        },
        401
      );
    }

    if (!isAdmin(currentUser)) {
      return json(
        {
          ok: false,
          error: "Admin access required."
        },
        403
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON."
        },
        400
      );
    }

    const userId =
      Number(body?.user_id);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return json(
        {
          ok: false,
          error: "Invalid user_id."
        },
        400
      );
    }

    const targetUser =
      await env.DB.prepare(`
        SELECT
          id,
          username,
          server,
          role
        FROM users
        WHERE id = ?
        LIMIT 1
      `)
        .bind(userId)
        .first();

    if (!targetUser) {
      return json(
        {
          ok: false,
          error: "User not found."
        },
        404
      );
    }

    if (isAdmin(targetUser)) {
      return json(
        {
          ok: false,
          error:
            "Administrator accounts are protected."
        },
        403
      );
    }

    await expireOldBans(env);

    const activeBan =
      await getActiveBan(
        env,
        userId
      );

    if (!activeBan) {
      return json(
        {
          ok: false,
          error:
            "User does not have an active forum ban."
        },
        404
      );
    }

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      UPDATE forum_bans
      SET active = 0
      WHERE user_id = ?
        AND active = 1
    `)
      .bind(userId)
      .run();

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
          currentUser.id,
          userId,
          "forum_unban",
          JSON.stringify({
            previous_ban_id:
              activeBan.id
          }),
          now
        )
        .run();
    } catch (logError) {
      console.error(
        "Forum unban moderation log error:",
        logError
      );
    }

    return json({
      ok: true,

      message:
        `${targetUser.username} was forum unbanned.`,

      user: {
        id: Number(targetUser.id),
        username: targetUser.username,
        server: targetUser.server
      },

      banned: false,
      ban: null
    });
  } catch (error) {
    console.error(
      "Forum bans DELETE error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

export async function onRequestPut() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

export async function onRequestPatch() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}
