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

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

/*
 * =====================================================
 * ABGELAUFENE BANNS DEAKTIVIEREN
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
 * AKTIVEN BANN LADEN
 * =====================================================
 */
async function getActiveBan(
  env,
  userId
) {
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
      userId,
      now
    )
    .first();
}

/*
 * =====================================================
 * OFFENEN KICK LADEN
 * =====================================================
 *
 * Ein Kick bleibt so lange offen, bis das Frontend
 * ihn bestätigt.
 *
 * Dadurch kann der Spieler das Popup nicht verpassen,
 * nur weil zwischen zwei Polls einige Sekunden liegen.
 */
async function getPendingKick(
  env,
  userId
) {
  return await env.DB.prepare(`
    SELECT
      k.id,
      k.user_id,
      k.kicked_by,
      k.reason,
      k.created_at,
      k.acknowledged_at,

      admin.username
        AS kicked_by_username

    FROM chat_kicks k

    LEFT JOIN users admin
      ON admin.id =
        k.kicked_by

    WHERE k.user_id = ?
      AND k.acknowledged_at IS NULL

    ORDER BY
      k.created_at DESC,
      k.id DESC

    LIMIT 1
  `)
    .bind(userId)
    .first();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Wird später von V24 regelmäßig abgefragt.
 *
 * Beispiel Bann:
 *
 * {
 *   "ok": true,
 *   "banned": true,
 *   "ban": {
 *      "reason": "Spam",
 *      "expires_at": ...,
 *      "remaining_seconds": 583
 *   }
 * }
 *
 * Beispiel Kick:
 *
 * {
 *   "ok": true,
 *   "kicked": true,
 *   "kick": {...}
 * }
 *
 * ADMIN:
 *
 * Admins sind vollständig immun gegen Chat-Banns
 * und Chat-Kicks.
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

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * =================================================
     * ADMIN-IMMUNITÄT
     * =================================================
     */
    if (isAdmin(user)) {
      return json({
        ok: true,

        server_time:
          now,

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

        ban:
          null,

        kicked:
          false,

        kick:
          null
      });
    }

    /*
     * Alte abgelaufene Banns automatisch deaktivieren.
     */
    await expireOldBans(
      env,
      user.id
    );

    const ban =
      await getActiveBan(
        env,
        user.id
      );

    const kick =
      await getPendingKick(
        env,
        user.id
      );

    let banData = null;

    if (ban) {
      const permanent =
        ban.expires_at ===
        null;

      const remainingSeconds =
        permanent
          ? null
          : Math.max(
              0,
              Number(
                ban.expires_at
              ) - now
            );

      banData = {
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
          remainingSeconds,

        banned_by: {
          id:
            ban.banned_by,

          username:
            ban.banned_by_username ||
            null
        }
      };
    }

    let kickData = null;

    if (kick) {
      kickData = {
        id:
          kick.id,

        reason:
          kick.reason || null,

        created_at:
          kick.created_at,

        kicked_by: {
          id:
            kick.kicked_by,

          username:
            kick.kicked_by_username ||
            null
        }
      };
    }

    return json({
      ok: true,

      server_time:
        now,

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
        Boolean(ban),

      ban:
        banData,

      kicked:
        Boolean(kick),

      kick:
        kickData
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
 * POST
 * =====================================================
 *
 * Aktuell:
 *
 * acknowledge_kick
 *
 * Nachdem V24 dem Spieler das Kick-Popup angezeigt
 * hat, bestätigt das Frontend den Kick.
 *
 * Beispiel:
 *
 * {
 *   "action": "acknowledge_kick",
 *   "kick_id": 12
 * }
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

    /*
     * Admins können nicht wirksam gekickt werden.
     */
    if (isAdmin(user)) {
      return json({
        ok: true,

        ignored:
          true,

        message:
          "Administratoren sind von Chat-Kicks ausgenommen."
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
      typeof body.action ===
      "string"
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
      Number(
        body.kick_id
      );

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
     * Sicherstellen, dass dieser Kick wirklich
     * zum eingeloggten Account gehört.
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
     * Bereits bestätigt:
     *
     * Kein Fehler. Der Endpoint bleibt dadurch
     * idempotent.
     */
    if (
      kick.acknowledged_at !==
        null &&
      kick.acknowledged_at !==
        undefined
    ) {
      return json({
        ok: true,

        kick_id:
          kick.id,

        already_acknowledged:
          true
      });
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      UPDATE chat_kicks

      SET acknowledged_at = ?

      WHERE id = ?
        AND user_id = ?
        AND acknowledged_at IS NULL
    `)
      .bind(
        now,
        kick.id,
        user.id
      )
      .run();

    /*
     * =================================================
     * PRESENCE ENTFERNEN
     * =================================================
     *
     * Dadurch verschwindet der Spieler direkt aus
     * der Online-Liste.
     */
    await env.DB.prepare(`
      DELETE FROM chat_presence

      WHERE user_id = ?
    `)
      .bind(
        user.id
      )
      .run();

    return json({
      ok: true,

      kick_id:
        kick.id,

      already_acknowledged:
        false,

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

/*
 * =====================================================
 * PUT
 * =====================================================
 */
export async function onRequestPut() {
  return json({
    ok: false,
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
    ok: false,
    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}
