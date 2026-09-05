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

function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get("Cookie") || "";

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

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function getServerCode(server) {
  return (
    SERVER_MAP[server] ||
    server ||
    ""
  );
}

function normalizeText(value) {
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
 * USER LOOKUP
 * =====================================================
 */
async function getUserById(
  env,
  id
) {
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

/*
 * =====================================================
 * ADMIN AUTH
 * =====================================================
 */
async function requireAdmin(
  request,
  env
) {
  const user =
    await getCurrentUser(
      request,
      env
    );

  if (!user) {
    return {
      ok: false,

      response:
        json({
          ok: false,
          error:
            "Du musst eingeloggt sein."
        }, 401)
    };
  }

  if (!isAdmin(user)) {
    return {
      ok: false,

      response:
        json({
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

/*
 * =====================================================
 * TARGET VALIDATION
 * =====================================================
 */
async function validateTarget(
  env,
  admin,
  targetUserId
) {
  if (
    !Number.isInteger(
      targetUserId
    ) ||
    targetUserId <= 0
  ) {
    return {
      ok: false,

      response:
        json({
          ok: false,
          error:
            "Ungültiger Spieler."
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

      response:
        json({
          ok: false,
          error:
            "Spieler wurde nicht gefunden."
        }, 404)
    };
  }

  /*
   * =================================================
   * ADMIN-IMMUNITÄT
   * =================================================
   *
   * Ausschließlich role === "admin" entscheidet.
   *
   * Ein Admin kann nicht:
   *
   * - gekickt
   * - gebannt
   * - entbannt
   * - anderweitig moderiert
   *
   * werden.
   */
  if (
    target.role ===
    "admin"
  ) {
    return {
      ok: false,

      response:
        json({
          ok: false,
          error:
            "Der Administrator kann nicht moderiert werden."
        }, 403)
    };
  }

  if (
    Number(target.id) ===
    Number(admin.id)
  ) {
    return {
      ok: false,

      response:
        json({
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

/*
 * =====================================================
 * ALTE BANNS DEAKTIVIEREN
 * =====================================================
 */
async function expireOldBans(env) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

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
 * MODERATION LOG
 * =====================================================
 */
async function addModerationLog(
  env,
  adminId,
  targetUserId,
  action,
  details
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

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
        adminId,
        targetUserId,
        action,
        JSON.stringify(
          details || {}
        ),
        now
      )
      .run();

  } catch (error) {
    /*
     * Eine Moderationsaktion soll nicht daran
     * scheitern, dass ausschließlich das Log
     * einen Fehler hat.
     */
    console.error(
      "Moderation log error:",
      error
    );
  }
}

/*
 * =====================================================
 * INTERNE MODERATIONSNOTIZ
 * =====================================================
 *
 * Wird ausschließlich gespeichert, wenn tatsächlich
 * Text übergeben wurde.
 *
 * Unterstützte Body-Felder:
 *
 * internal_note
 * moderation_note
 *
 * Beispiel:
 *
 * {
 *   "internal_note":
 *     "Bereits mehrfach wegen Spam aufgefallen."
 * }
 */
async function addModerationNote(
  env,
  adminId,
  targetUserId,
  relatedType,
  relatedId,
  note
) {
  const cleanNote =
    normalizeText(note);

  if (!cleanNote) {
    return;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB.prepare(`
    INSERT INTO chat_moderation_notes (
      target_user_id,
      admin_id,
      related_type,
      related_id,
      note,
      created_at
    )

    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .bind(
      targetUserId,
      adminId,
      relatedType || null,
      relatedId || null,
      cleanNote,
      now
    )
    .run();
}

/*
 * =====================================================
 * ÖFFENTLICHE SYSTEMMELDUNG
 * =====================================================
 *
 * Wichtig:
 *
 * Hier werden bewusst NICHT gespeichert:
 *
 * - Moderationsgrund
 * - Banndauer
 * - interne Notiz
 *
 * Sichtbar ist öffentlich ausschließlich:
 *
 * "Spieler wurde aus dem Chat gekickt."
 *
 * bzw.
 *
 * "Spieler wurde aus dem Chat gebannt."
 *
 *
 * Wir erzeugen zwei Systemmeldungen:
 *
 * 1. Globalchat
 * 2. eigener Serverchat des Spielers
 *
 * Dadurch sehen Spieler die Moderationsaktion in
 * beiden relevanten öffentlichen Bereichen.
 */
async function addPublicModerationMessages(
  env,
  eventType,
  target
) {
  if (
    eventType !== "kick" &&
    eventType !== "ban"
  ) {
    return;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  /*
   * Global
   */
  await env.DB.prepare(`
    INSERT INTO chat_system_messages (
      room_type,
      server,
      event_type,
      target_user_id,
      target_username,
      created_at
    )

    VALUES (
      'global',
      NULL,
      ?,
      ?,
      ?,
      ?
    )
  `)
    .bind(
      eventType,
      target.id,
      target.username,
      now
    )
    .run();

  /*
   * Serverchat
   */
  if (target.server) {
    await env.DB.prepare(`
      INSERT INTO chat_system_messages (
        room_type,
        server,
        event_type,
        target_user_id,
        target_username,
        created_at
      )

      VALUES (
        'server',
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `)
      .bind(
        target.server,
        eventType,
        target.id,
        target.username,
        now
      )
      .run();
  }
}

/*
 * =====================================================
 * PRESENCE ENTFERNEN
 * =====================================================
 *
 * Kick/Bann soll unmittelbar die bestehende
 * Online-Presence entfernen.
 */
async function removePresence(
  env,
  userId
) {
  await env.DB.prepare(`
    DELETE FROM chat_presence

    WHERE user_id = ?
  `)
    .bind(userId)
    .run();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Nur Admin.
 *
 * Standard:
 *
 * /api/chat/bans
 *
 * entspricht:
 *
 * /api/chat/bans?status=active
 *
 *
 * Verlauf:
 *
 * /api/chat/bans?status=all
 */
export async function onRequestGet(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireAdmin(
        request,
        env
      );

    if (!auth.ok) {
      return auth.response;
    }

    await expireOldBans(env);

    const url =
      new URL(
        request.url
      );

    const status =
      url.searchParams.get(
        "status"
      ) || "active";

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

    const rawLimit =
      Number(
        url.searchParams.get(
          "limit"
        ) || 100
      );

    const limit =
      Number.isFinite(rawLimit)
        ? Math.max(
            1,
            Math.min(
              Math.floor(
                rawLimit
              ),
              200
            )
          )
        : 100;

    let result;

    if (
      status === "active"
    ) {
      result =
        await env.DB.prepare(`
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
            ON target.id =
              b.user_id

          JOIN users admin
            ON admin.id =
              b.banned_by

          WHERE b.active = 1

          ORDER BY
            b.banned_at DESC,
            b.id DESC

          LIMIT ?
        `)
          .bind(limit)
          .all();

    } else {
      result =
        await env.DB.prepare(`
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
            ON target.id =
              b.user_id

          JOIN users admin
            ON admin.id =
              b.banned_by

          ORDER BY
            b.banned_at DESC,
            b.id DESC

          LIMIT ?
        `)
          .bind(limit)
          .all();
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const bans =
      (
        result.results || []
      ).map(item => {
        const permanent =
          item.expires_at ===
          null;

        const stillActive =
          Boolean(
            item.active
          ) &&
          (
            permanent ||
            Number(
              item.expires_at
            ) > now
          );

        return {
          id:
            item.id,

          user: {
            id:
              item.user_id,

            username:
              item.target_username,

            server:
              item.target_server,

            server_code:
              getServerCode(
                item.target_server
              ),

            role:
              item.target_role
          },

          banned_by: {
            id:
              item.banned_by,

            username:
              item.admin_username
          },

          reason:
            item.reason || null,

          banned_at:
            item.banned_at,

          expires_at:
            item.expires_at,

          permanent,

          active:
            stillActive,

          remaining_seconds:
            stillActive &&
            !permanent
              ? Math.max(
                  0,
                  Number(
                    item.expires_at
                  ) - now
                )
              : null
        };
      });

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
 *
 * KICK:
 *
 * {
 *   "action": "kick",
 *   "user_id": 123,
 *   "reason": "Spam",
 *   "internal_note": "Optional"
 * }
 *
 *
 * BANN:
 *
 * {
 *   "action": "ban",
 *   "user_id": 123,
 *   "duration": "24h",
 *   "reason": "Beleidigungen",
 *   "internal_note": "Optional"
 * }
 *
 *
 * Erlaubte Banndauern:
 *
 * 10m
 * 30m
 * 1h
 * 6h
 * 24h
 * 7d
 * permanent
 */
export async function onRequestPost(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireAdmin(
        request,
        env
      );

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
      typeof body.action ===
      "string"
        ? body.action
            .trim()
            .toLowerCase()
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
      Number(
        body.user_id
      );

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
      normalizeText(
        body.reason
      );

    const internalNote =
      normalizeText(
        body.internal_note ||
        body.moderation_note
      );

    if (
      reason.length > 500
    ) {
      return json({
        ok: false,
        error:
          "Der Grund darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    if (
      internalNote.length >
      2000
    ) {
      return json({
        ok: false,
        error:
          "Die interne Moderationsnotiz darf maximal 2000 Zeichen enthalten."
      }, 400);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * =================================================
     * KICK
     * =================================================
     */
    if (
      action === "kick"
    ) {
      const kickResult =
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

      const kickId =
        kickResult?.meta
          ?.last_row_id ||
        null;

      /*
       * Spieler sofort aus Online-Presence entfernen.
       */
      await removePresence(
        env,
        target.id
      );

      /*
       * Öffentliche Systemmeldungen.
       *
       * Keine Dauer.
       * Kein Grund.
       */
      await addPublicModerationMessages(
        env,
        "kick",
        target
      );

      /*
       * Interne Notiz.
       */
      if (internalNote) {
        await addModerationNote(
          env,
          admin.id,
          target.id,
          "kick",
          kickId,
          internalNote
        );
      }

      await addModerationLog(
        env,
        admin.id,
        target.id,
        "kick",
        {
          kick_id:
            kickId,

          reason:
            reason || null,

          internal_note:
            internalNote || null,

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

        kick: {
          id:
            kickId,

          user_id:
            target.id,

          kicked_by:
            admin.id,

          reason:
            reason || null,

          created_at:
            now
        },

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
     * =================================================
     * BANN
     * =================================================
     */
    const duration =
      typeof body.duration ===
      "string"
        ? body.duration
            .trim()
            .toLowerCase()
        : "";

    if (
      !Object.prototype
        .hasOwnProperty.call(
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
     * Parallel aktive Banns verhindern.
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
          banned_at DESC,
          id DESC

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
            existing.expires_at ===
            null
        }
      }, 409);
    }

    const seconds =
      BAN_DURATIONS[
        duration
      ];

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

        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          1
        )
      `)
        .bind(
          target.id,
          admin.id,
          reason || null,
          now,
          expiresAt
        )
        .run();

    const banId =
      result?.meta
        ?.last_row_id ||
      null;

    /*
     * Gebannter Spieler verschwindet sofort aus
     * der Online-Anzeige.
     */
    await removePresence(
      env,
      target.id
    );

    /*
     * Öffentliche Systemmeldung.
     *
     * Absichtlich nur:
     *
     * "X wurde aus dem Chat gebannt."
     *
     * Keine Dauer.
     * Kein Grund.
     */
    await addPublicModerationMessages(
      env,
      "ban",
      target
    );

    /*
     * Interne Admin-Notiz.
     */
    if (internalNote) {
      await addModerationNote(
        env,
        admin.id,
        target.id,
        "ban",
        banId,
        internalNote
      );
    }

    await addModerationLog(
      env,
      admin.id,
      target.id,
      "ban",
      {
        ban_id:
          banId,

        username:
          target.username,

        server:
          target.server,

        duration,

        reason:
          reason || null,

        internal_note:
          internalNote || null,

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
          banId,

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
        `${target.username} wurde aus dem Chat gebannt.`
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
 * Aktiven Bann vorzeitig aufheben.
 *
 * DELETE /api/chat/bans?id=12
 *
 *
 * WICHTIG:
 *
 * Beim Unban gibt es KEINE öffentliche Systemmeldung.
 */
export async function onRequestDelete(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const auth =
      await requireAdmin(
        request,
        env
      );

    if (!auth.ok) {
      return auth.response;
    }

    const admin =
      auth.user;

    await expireOldBans(env);

    const url =
      new URL(
        request.url
      );

    const banId =
      toPositiveInt(
        url.searchParams.get(
          "id"
        )
      );

    if (!banId) {
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
          ON u.id =
            b.user_id

        WHERE b.id = ?

        LIMIT 1
      `)
        .bind(
          banId
        )
        .first();

    if (!ban) {
      return json({
        ok: false,
        error:
          "Bann wurde nicht gefunden."
      }, 404);
    }

    /*
     * Auch alte/manipulierte Daten dürfen niemals
     * zur Moderation eines Admin-Accounts führen.
     */
    if (
      ban.role ===
      "admin"
    ) {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht moderiert werden."
      }, 403);
    }

    if (
      !ban.active
    ) {
      return json({
        ok: false,
        error:
          "Dieser Bann ist bereits inaktiv."
      }, 409);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      UPDATE chat_bans

      SET active = 0

      WHERE id = ?
        AND active = 1
    `)
      .bind(
        banId
      )
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
          ban.expires_at,

        unbanned_at:
          now
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
