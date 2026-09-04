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

const BAN_DURATIONS = {
  "10m": 10 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "permanent": null
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
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function getServerCode(server) {
  return SERVER_MAP[server] || server;
}

function normalizeReason(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

async function getUserById(env, id) {
  return await env.DB.prepare(`
    SELECT
      id,
      username,
      server,
      role
    FROM users
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

async function requireAdmin(request, env) {
  const user =
    await getCurrentUser(request, env);

  if (!user) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401)
    };
  }

  if (!isAdmin(user)) {
    return {
      ok: false,
      response: json({
        ok: false,
        error:
          "Nur der Administrator darf diese Aktion ausführen."
      }, 403)
    };
  }

  return {
    ok: true,
    user
  };
}

async function validateTarget(
  env,
  admin,
  targetUserId
) {
  if (
    !Number.isInteger(targetUserId) ||
    targetUserId <= 0
  ) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "Ungültiger Spieler."
      }, 400)
    };
  }

  const target =
    await getUserById(
      env,
      targetUserId
    );

  if (!target) {
    return {
      ok: false,
      response: json({
        ok: false,
        error:
          "Spieler wurde nicht gefunden."
      }, 404)
    };
  }

  /*
   * ============================================
   * ADMIN-SCHUTZ
   * ============================================
   *
   * Kein Admin-Account kann:
   * - gekickt
   * - gebannt
   * - entbannt
   * - anderweitig moderiert
   * werden.
   *
   * Entscheidend ist ausschließlich role=admin.
   */
  if (target.role === "admin") {
    return {
      ok: false,
      response: json({
        ok: false,
        error:
          "Der Administrator kann nicht moderiert werden."
      }, 403)
    };
  }

  if (target.id === admin.id) {
    return {
      ok: false,
      response: json({
        ok: false,
        error:
          "Du kannst diese Aktion nicht gegen dich selbst ausführen."
      }, 403)
    };
  }

  return {
    ok: true,
    target
  };
}

async function expireOldBans(env) {
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

async function addModerationLog(
  env,
  adminId,
  targetUserId,
  action,
  details
) {
  const now =
    Math.floor(Date.now() / 1000);

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
      adminId,
      targetUserId,
      action,
      JSON.stringify(details || {}),
      now
    )
    .run();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Nur Admin.
 *
 * Zeigt standardmäßig alle AKTIVEN Banns.
 *
 * Optional:
 *
 * /api/chat/bans?status=active
 * /api/chat/bans?status=all
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const auth =
      await requireAdmin(request, env);

    if (!auth.ok) {
      return auth.response;
    }

    await expireOldBans(env);

    const url =
      new URL(request.url);

    const status =
      url.searchParams.get("status") ||
      "active";

    if (
      status !== "active" &&
      status !== "all"
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Bannfilter."
      }, 400);
    }

    const limitRaw =
      Number(
        url.searchParams.get("limit") ||
        100
      );

    const limit =
      Math.max(
        1,
        Math.min(limitRaw, 200)
      );

    let query;
    let bindings;

    if (status === "active") {
      query = `
        SELECT
          b.id,
          b.user_id,
          b.banned_by,
          b.reason,
          b.banned_at,
          b.expires_at,
          b.active,

          target.username
            AS target_username,

          target.server
            AS target_server,

          target.role
            AS target_role,

          admin.username
            AS admin_username

        FROM chat_bans b

        JOIN users target
          ON target.id = b.user_id

        JOIN users admin
          ON admin.id = b.banned_by

        WHERE b.active = 1

        ORDER BY
          b.banned_at DESC

        LIMIT ?
      `;

      bindings = [limit];
    } else {
      query = `
        SELECT
          b.id,
          b.user_id,
          b.banned_by,
          b.reason,
          b.banned_at,
          b.expires_at,
          b.active,

          target.username
            AS target_username,

          target.server
            AS target_server,

          target.role
            AS target_role,

          admin.username
            AS admin_username

        FROM chat_bans b

        JOIN users target
          ON target.id = b.user_id

        JOIN users admin
          ON admin.id = b.banned_by

        ORDER BY
          b.banned_at DESC

        LIMIT ?
      `;

      bindings = [limit];
    }

    const result =
      await env.DB
        .prepare(query)
        .bind(...bindings)
        .all();

    const now =
      Math.floor(Date.now() / 1000);

    const bans =
      (result.results || []).map(
        item => ({
          id: item.id,

          user: {
            id: item.user_id,
            username:
              item.target_username,
            server:
              item.target_server,
            server_code:
              getServerCode(
                item.target_server
              )
          },

          banned_by: {
            id: item.banned_by,
            username:
              item.admin_username
          },

          reason:
            item.reason,

          banned_at:
            item.banned_at,

          expires_at:
            item.expires_at,

          permanent:
            item.expires_at === null,

          active:
            Boolean(item.active) &&
            (
              item.expires_at === null ||
              item.expires_at > now
            )
        })
      );

    return json({
      ok: true,

      filter:
        status,

      bans
    });

  } catch (error) {
    console.error(
      "GET /api/chat/bans error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Bannliste konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Nur Admin.
 *
 * Zwei Aktionen:
 *
 * 1. Kick
 *
 * {
 *   "action": "kick",
 *   "user_id": 123,
 *   "reason": "Spam"
 * }
 *
 *
 * 2. Bann
 *
 * {
 *   "action": "ban",
 *   "user_id": 123,
 *   "duration": "24h",
 *   "reason": "Beleidigungen"
 * }
 *
 *
 * Erlaubte duration:
 *
 * 10m
 * 30m
 * 1h
 * 6h
 * 24h
 * 7d
 * permanent
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const auth =
      await requireAdmin(request, env);

    if (!auth.ok) {
      return auth.response;
    }

    const admin =
      auth.user;

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

    const action =
      typeof body.action === "string"
        ? body.action.toLowerCase()
        : "";

    if (
      action !== "kick" &&
      action !== "ban"
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Moderationsaktion."
      }, 400);
    }

    const targetUserId =
      Number(body.user_id);

    const validation =
      await validateTarget(
        env,
        admin,
        targetUserId
      );

    if (!validation.ok) {
      return validation.response;
    }

    const target =
      validation.target;

    const reason =
      normalizeReason(body.reason);

    if (reason.length > 500) {
      return json({
        ok: false,
        error:
          "Der Grund darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    const now =
      Math.floor(Date.now() / 1000);

    /*
     * =============================================
     * KICK
     * =============================================
     */
    if (action === "kick") {
      await env.DB.prepare(`
        INSERT INTO chat_kicks (
          user_id,
          kicked_by,
          reason,
          created_at
        )
        VALUES (?, ?, ?, ?)
      `)
        .bind(
          target.id,
          admin.id,
          reason || null,
          now
        )
        .run();

      await addModerationLog(
        env,
        admin.id,
        target.id,
        "kick",
        {
          reason:
            reason || null,

          username:
            target.username,

          server:
            target.server
        }
      );

      return json({
        ok: true,

        action:
          "kick",

        user: {
          id:
            target.id,

          username:
            target.username,

          server:
            target.server,

          server_code:
            getServerCode(
              target.server
            )
        },

        message:
          `${target.username} wurde aus dem Chat gekickt.`
      });
    }

    /*
     * =============================================
     * BANN
     * =============================================
     */

    const duration =
      typeof body.duration === "string"
        ? body.duration
        : "";

    if (
      !Object.prototype.hasOwnProperty.call(
        BAN_DURATIONS,
        duration
      )
    ) {
      return json({
        ok: false,

        error:
          "Ungültige Banndauer.",

        allowed_durations: [
          "10m",
          "30m",
          "1h",
          "6h",
          "24h",
          "7d",
          "permanent"
        ]
      }, 400);
    }

    await expireOldBans(env);

    /*
     * Wenn bereits ein aktiver Bann besteht,
     * verhindern wir einen zweiten parallelen Bann.
     */
    const existing =
      await env.DB.prepare(`
        SELECT
          id,
          expires_at
        FROM chat_bans
        WHERE user_id = ?
          AND active = 1
          AND (
            expires_at IS NULL
            OR expires_at > ?
          )
        ORDER BY
          banned_at DESC
        LIMIT 1
      `)
        .bind(
          target.id,
          now
        )
        .first();

    if (existing) {
      return json({
        ok: false,

        error:
          "Dieser Spieler ist bereits vom Chat gebannt.",

        ban: {
          id:
            existing.id,

          expires_at:
            existing.expires_at,

          permanent:
            existing.expires_at === null
        }
      }, 409);
    }

    const seconds =
      BAN_DURATIONS[duration];

    const expiresAt =
      seconds === null
        ? null
        : now + seconds;

    const result =
      await env.DB.prepare(`
        INSERT INTO chat_bans (
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
          target.id,
          admin.id,
          reason || null,
          now,
          expiresAt
        )
        .run();

    await addModerationLog(
      env,
      admin.id,
      target.id,
      "ban",
      {
        ban_id:
          result.meta.last_row_id,

        username:
          target.username,

        server:
          target.server,

        duration,

        reason:
          reason || null,

        expires_at:
          expiresAt,

        permanent:
          expiresAt === null
      }
    );

    return json({
      ok: true,

      action:
        "ban",

      ban: {
        id:
          result.meta.last_row_id,

        user: {
          id:
            target.id,

          username:
            target.username,

          server:
            target.server,

          server_code:
            getServerCode(
              target.server
            )
        },

        reason:
          reason || null,

        duration,

        banned_at:
          now,

        expires_at:
          expiresAt,

        permanent:
          expiresAt === null
      },

      message:
        expiresAt === null
          ? `${target.username} wurde permanent vom Chat gebannt.`
          : `${target.username} wurde zeitweise vom Chat gebannt.`
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/bans error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Moderationsaktion konnte nicht ausgeführt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Nur Admin.
 *
 * Hebt einen aktiven Bann vorzeitig auf.
 *
 * Beispiel:
 *
 * DELETE /api/chat/bans?id=12
 */
export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const auth =
      await requireAdmin(request, env);

    if (!auth.ok) {
      return auth.response;
    }

    const admin =
      auth.user;

    await expireOldBans(env);

    const url =
      new URL(request.url);

    const banId =
      Number(
        url.searchParams.get("id")
      );

    if (
      !Number.isInteger(banId) ||
      banId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Bann-ID."
      }, 400);
    }

    const ban =
      await env.DB.prepare(`
        SELECT
          b.id,
          b.user_id,
          b.reason,
          b.banned_at,
          b.expires_at,
          b.active,

          u.username,
          u.server,
          u.role

        FROM chat_bans b

        JOIN users u
          ON u.id = b.user_id

        WHERE b.id = ?

        LIMIT 1
      `)
        .bind(banId)
        .first();

    if (!ban) {
      return json({
        ok: false,
        error:
          "Bann wurde nicht gefunden."
      }, 404);
    }

    /*
     * Auch hier erneut Adminschutz.
     * Selbst alte/manipulierte Datensätze können nicht
     * zur Moderation eines Admin-Accounts benutzt werden.
     */
    if (ban.role === "admin") {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht moderiert werden."
      }, 403);
    }

    if (!ban.active) {
      return json({
        ok: false,
        error:
          "Dieser Bann ist bereits inaktiv."
      }, 409);
    }

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      UPDATE chat_bans
      SET active = 0
      WHERE id = ?
    `)
      .bind(banId)
      .run();

    await addModerationLog(
      env,
      admin.id,
      ban.user_id,
      "unban",
      {
        ban_id:
          ban.id,

        username:
          ban.username,

        server:
          ban.server,

        previous_reason:
          ban.reason,

        previous_expires_at:
          ban.expires_at
      }
    );

    return json({
      ok: true,

      action:
        "unban",

      user: {
        id:
          ban.user_id,

        username:
          ban.username,

        server:
          ban.server,

        server_code:
          getServerCode(
            ban.server
          )
      },

      message:
        `${ban.username} wurde für den Chat entsperrt.`
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/bans error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Bann konnte nicht aufgehoben werden."
    }, 500);
  }
}
