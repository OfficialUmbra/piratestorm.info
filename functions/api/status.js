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

/*
 * =====================================================
 * ABGELAUFENE BANS AUFRÄUMEN
 * =====================================================
 */
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

/*
 * =====================================================
 * AKTIVEN BAN LADEN
 * =====================================================
 *
 * WICHTIG:
 * Admin ist grundsätzlich immun.
 *
 * Selbst ein alter/manipulierter DB-Eintrag
 * kann einen Admin nicht sperren.
 */
async function getActiveBan(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  await cleanupExpiredBans(env);

  const now =
    Math.floor(Date.now() / 1000);

  return await env.DB.prepare(`
    SELECT
      cb.id,
      cb.reason,
      cb.banned_at,
      cb.expires_at,

      admin.username
        AS banned_by_username

    FROM chat_bans cb

    LEFT JOIN users admin
      ON admin.id = cb.banned_by

    WHERE cb.user_id = ?
      AND cb.active = 1
      AND (
        cb.expires_at IS NULL
        OR cb.expires_at > ?
      )

    ORDER BY
      cb.banned_at DESC,
      cb.id DESC

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
 * OFFENEN KICK LADEN
 * =====================================================
 *
 * acknowledged_at IS NULL bedeutet:
 * Dieser Kick wurde vom Chat-Client noch
 * nicht verarbeitet.
 *
 * Auch hier gilt:
 * Admin kann niemals gekickt werden.
 */
async function getPendingKick(env, user) {
  if (!user || isAdmin(user)) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT
      ck.id,
      ck.reason,
      ck.created_at,

      admin.username
        AS kicked_by_username

    FROM chat_kicks ck

    LEFT JOIN users admin
      ON admin.id = ck.kicked_by

    WHERE ck.user_id = ?
      AND ck.acknowledged_at IS NULL

    ORDER BY
      ck.created_at ASC,
      ck.id ASC

    LIMIT 1
  `)
    .bind(user.id)
    .first();
}

/*
 * =====================================================
 * GET /api/chat/status
 * =====================================================
 *
 * Wird später vom Chat-Frontend regelmäßig
 * abgefragt.
 *
 * Beispiele:
 *
 * normal:
 * {
 *   ok: true,
 *   banned: false,
 *   kicked: false
 * }
 *
 * Kick:
 * {
 *   ok: true,
 *   banned: false,
 *   kicked: true,
 *   kick: {...}
 * }
 *
 * Ban:
 * {
 *   ok: true,
 *   banned: true,
 *   kicked: false,
 *   ban: {...}
 * }
 *
 * GET verändert absichtlich NICHT den Kick.
 * Erst POST bestätigt ihn.
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

    /*
     * =============================================
     * ADMIN-IMMUNITÄT
     * =============================================
     *
     * Wir fragen bei Admin weder Bans noch Kicks
     * als wirksame Einschränkung ab.
     */
    if (isAdmin(user)) {
      return json({
        ok: true,

        user: {
          id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          role:
            user.role,

          is_admin:
            true
        },

        banned:
          false,

        kicked:
          false,

        ban:
          null,

        kick:
          null
      });
    }

    /*
     * =============================================
     * BAN HAT VORRANG
     * =============================================
     */
    const ban =
      await getActiveBan(
        env,
        user
      );

    if (ban) {
      /*
       * Gebannte Spieler sollen nicht mehr als
       * online im Chat erscheinen.
       */
      await env.DB.prepare(`
        DELETE FROM chat_presence
        WHERE user_id = ?
      `)
        .bind(user.id)
        .run();

      return json({
        ok: true,

        user: {
          id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          role:
            user.role,

          is_admin:
            false
        },

        banned:
          true,

        kicked:
          false,

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
            ban.expires_at === null,

          banned_by:
            ban.banned_by_username || null
        },

        kick:
          null
      });
    }

    /*
     * =============================================
     * OFFENEN KICK PRÜFEN
     * =============================================
     */
    const kick =
      await getPendingKick(
        env,
        user
      );

    if (kick) {
      /*
       * Bereits beim Erkennen entfernen wir den
       * Spieler aus der Presence-Liste.
       *
       * Dadurch verschwindet er sofort aus
       * "Online Spieler".
       */
      await env.DB.prepare(`
        DELETE FROM chat_presence
        WHERE user_id = ?
      `)
        .bind(user.id)
        .run();

      return json({
        ok: true,

        user: {
          id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          role:
            user.role,

          is_admin:
            false
        },

        banned:
          false,

        kicked:
          true,

        ban:
          null,

        kick: {
          id:
            kick.id,

          reason:
            kick.reason || null,

          created_at:
            kick.created_at,

          kicked_by:
            kick.kicked_by_username || null
        }
      });
    }

    /*
     * =============================================
     * ALLES OK
     * =============================================
     */
    return json({
      ok: true,

      user: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        role:
          user.role,

        is_admin:
          false
      },

      banned:
        false,

      kicked:
        false,

      ban:
        null,

      kick:
        null
    });

  } catch (error) {
    console.error(
      "GET /api/chat/status error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Chat-Status konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST /api/chat/status
 * =====================================================
 *
 * Bestätigt ausschließlich einen erhaltenen Kick.
 *
 * Body:
 *
 * {
 *   "action": "acknowledge_kick",
 *   "kick_id": 12
 * }
 *
 * Dadurch kann ein alter Kick später nicht
 * erneut ausgelöst werden.
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

    /*
     * Admin benötigt diese Funktion nicht.
     *
     * Gleichzeitig kann dadurch kein manipulierter
     * Request einen Admin-Kick "verarbeiten".
     */
    if (isAdmin(user)) {
      return json({
        ok: true,
        acknowledged:
          false,

        message:
          "Administratoren sind gegen Chat-Kicks geschützt."
      });
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

    const action =
      typeof body.action === "string"
        ? body.action
            .trim()
            .toLowerCase()
        : "";

    if (
      action !==
      "acknowledge_kick"
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Status-Aktion."
      }, 400);
    }

    const kickId =
      Number(body.kick_id);

    if (
      !Number.isInteger(kickId) ||
      kickId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Kick-ID."
      }, 400);
    }

    /*
     * WICHTIG:
     *
     * Der Spieler kann ausschließlich seinen
     * eigenen Kick bestätigen.
     */
    const kick =
      await env.DB.prepare(`
        SELECT
          id,
          user_id,
          acknowledged_at
        FROM chat_kicks
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `)
        .bind(
          kickId,
          user.id
        )
        .first();

    if (!kick) {
      return json({
        ok: false,
        error:
          "Kick wurde nicht gefunden."
      }, 404);
    }

    /*
     * Idempotent:
     *
     * Doppelte Bestätigung verursacht keinen Fehler.
     */
    if (kick.acknowledged_at) {
      return json({
        ok: true,

        acknowledged:
          true,

        already_acknowledged:
          true,

        kick_id:
          kickId,

        acknowledged_at:
          kick.acknowledged_at
      });
    }

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      UPDATE chat_kicks
      SET acknowledged_at = ?
      WHERE id = ?
        AND user_id = ?
        AND acknowledged_at IS NULL
    `)
      .bind(
        now,
        kickId,
        user.id
      )
      .run();

    /*
     * Sicherheitshalber Presence erneut entfernen.
     *
     * Der Spieler soll erst wieder online erscheinen,
     * wenn das Frontend nach dem Kick bewusst neu
     * in den Chat einsteigt und Presence setzt.
     */
    await env.DB.prepare(`
      DELETE FROM chat_presence
      WHERE user_id = ?
    `)
      .bind(user.id)
      .run();

    return json({
      ok: true,

      acknowledged:
        true,

      already_acknowledged:
        false,

      kick_id:
        kickId,

      acknowledged_at:
        now
    });

  } catch (error) {
    console.error(
      "POST /api/chat/status error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Kick konnte nicht bestätigt werden."
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
