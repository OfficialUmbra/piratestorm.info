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

function cleanText(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
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

async function addModerationLog(
  env,
  adminId,
  action,
  details = null
) {
  try {
    await env.DB.prepare(`
      INSERT INTO chat_moderation_log (
        admin_id,
        target_user_id,
        action,
        details,
        created_at
      )

      VALUES (?, NULL, ?, ?, ?)
    `)
      .bind(
        adminId,
        action,
        details
          ? JSON.stringify(details)
          : null,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (error) {
    console.error(
      "Announcement moderation log error:",
      error
    );
  }
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Normal:
 *
 * GET /api/chat/announcements
 *
 * -> aktuelle aktive Ankündigung
 *
 *
 * Admin-Verlauf:
 *
 * GET /api/chat/announcements?all=1
 *
 * Optional:
 *
 * ?limit=50
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

    const url =
      new URL(request.url);

    const all =
      url.searchParams.get("all") === "1";

    /*
     * =================================================
     * AKTUELLE ANKÜNDIGUNG
     * =================================================
     */
    if (!all) {
      const announcement =
        await env.DB.prepare(`
          SELECT
            a.id,
            a.admin_id,
            a.message,
            a.active,
            a.created_at,

            u.username
              AS admin_username

          FROM chat_announcements a

          LEFT JOIN users u
            ON u.id = a.admin_id

          WHERE a.active = 1

          ORDER BY
            a.created_at DESC,
            a.id DESC

          LIMIT 1
        `)
          .first();

      return json({
        ok: true,

        announcement:
          announcement
            ? {
                id:
                  announcement.id,

                admin_id:
                  announcement.admin_id,

                admin_username:
                  announcement.admin_username || null,

                message:
                  announcement.message,

                active:
                  Boolean(announcement.active),

                created_at:
                  announcement.created_at
              }
            : null
      });
    }

    /*
     * =================================================
     * VERLAUF
     * =================================================
     *
     * Nur Admin.
     */
    if (!isAdmin(user)) {
      return json({
        ok: false,
        error:
          "Nur Administratoren dürfen den Ankündigungsverlauf sehen."
      }, 403);
    }

    let limit =
      Number(
        url.searchParams.get("limit") || 50
      );

    if (
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      limit = 50;
    }

    limit =
      Math.min(
        limit,
        200
      );

    const result =
      await env.DB.prepare(`
        SELECT
          a.id,
          a.admin_id,
          a.message,
          a.active,
          a.created_at,

          u.username
            AS admin_username

        FROM chat_announcements a

        LEFT JOIN users u
          ON u.id = a.admin_id

        ORDER BY
          a.created_at DESC,
          a.id DESC

        LIMIT ?
      `)
        .bind(limit)
        .all();

    const announcements =
      (
        result.results || []
      ).map(row => ({
        id:
          row.id,

        admin_id:
          row.admin_id,

        admin_username:
          row.admin_username || null,

        message:
          row.message,

        active:
          Boolean(row.active),

        created_at:
          row.created_at
      }));

    return json({
      ok: true,

      count:
        announcements.length,

      announcements
    });

  } catch (error) {
    console.error(
      "GET /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigungen konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Neue Ankündigung erstellen.
 *
 * Body:
 *
 * {
 *   "message": "Serverwartung um 20 Uhr."
 * }
 *
 * Die vorherige aktive Ankündigung wird deaktiviert.
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

    if (!isAdmin(user)) {
      return json({
        ok: false,
        error:
          "Nur Administratoren dürfen Ankündigungen erstellen."
      }, 403);
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

    const message =
      cleanText(
        body.message
      );

    if (!message) {
      return json({
        ok: false,
        error:
          "Die Ankündigung darf nicht leer sein."
      }, 400);
    }

    if (
      message.length > 500
    ) {
      return json({
        ok: false,
        error:
          "Die Ankündigung darf maximal 500 Zeichen lang sein."
      }, 400);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Vorherige aktive Ankündigungen deaktivieren.
     */
    await env.DB.prepare(`
      UPDATE chat_announcements

      SET active = 0

      WHERE active = 1
    `)
      .run();

    const created =
      await env.DB.prepare(`
        INSERT INTO chat_announcements (
          admin_id,
          message,
          active,
          created_at
        )

        VALUES (?, ?, 1, ?)

        RETURNING id
      `)
        .bind(
          user.id,
          message,
          now
        )
        .first();

    if (!created?.id) {
      return json({
        ok: false,
        error:
          "Die Ankündigung konnte nicht erstellt werden."
      }, 500);
    }

    await addModerationLog(
      env,
      user.id,
      "create_announcement",
      {
        announcement_id:
          created.id,

        message
      }
    );

    return json({
      ok: true,

      announcement: {
        id:
          created.id,

        admin_id:
          user.id,

        admin_username:
          user.username,

        message,

        active:
          true,

        created_at:
          now
      }
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht erstellt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Bestehende Ankündigung bearbeiten.
 *
 * Body:
 *
 * {
 *   "id": 12,
 *   "message": "Neuer Text"
 * }
 *
 * Die Aktivität bleibt dabei erhalten.
 */
export async function onRequestPut(context) {
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

    if (!isAdmin(user)) {
      return json({
        ok: false,
        error:
          "Nur Administratoren dürfen Ankündigungen bearbeiten."
      }, 403);
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

    const announcementId =
      toPositiveInt(
        body.id
      );

    if (!announcementId) {
      return json({
        ok: false,
        error:
          "Ungültige Ankündigungs-ID."
      }, 400);
    }

    const message =
      cleanText(
        body.message
      );

    if (!message) {
      return json({
        ok: false,
        error:
          "Die Ankündigung darf nicht leer sein."
      }, 400);
    }

    if (
      message.length > 500
    ) {
      return json({
        ok: false,
        error:
          "Die Ankündigung darf maximal 500 Zeichen lang sein."
      }, 400);
    }

    const existing =
      await env.DB.prepare(`
        SELECT
          id,
          admin_id,
          message,
          active,
          created_at

        FROM chat_announcements

        WHERE id = ?

        LIMIT 1
      `)
        .bind(
          announcementId
        )
        .first();

    if (!existing) {
      return json({
        ok: false,
        error:
          "Ankündigung wurde nicht gefunden."
      }, 404);
    }

    await env.DB.prepare(`
      UPDATE chat_announcements

      SET message = ?

      WHERE id = ?
    `)
      .bind(
        message,
        announcementId
      )
      .run();

    await addModerationLog(
      env,
      user.id,
      "edit_announcement",
      {
        announcement_id:
          announcementId,

        old_message:
          existing.message,

        new_message:
          message
      }
    );

    return json({
      ok: true,

      announcement: {
        id:
          announcementId,

        admin_id:
          existing.admin_id,

        message,

        active:
          Boolean(existing.active),

        created_at:
          existing.created_at
      }
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht bearbeitet werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Ankündigung deaktivieren.
 *
 * Möglich:
 *
 * DELETE /api/chat/announcements?id=12
 *
 * oder ohne ID:
 *
 * DELETE /api/chat/announcements
 *
 * Dann wird die aktuell aktive Ankündigung deaktiviert.
 */
export async function onRequestDelete(context) {
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

    if (!isAdmin(user)) {
      return json({
        ok: false,
        error:
          "Nur Administratoren dürfen Ankündigungen löschen."
      }, 403);
    }

    const url =
      new URL(request.url);

    let announcementId =
      toPositiveInt(
        url.searchParams.get("id")
      );

    let existing;

    if (announcementId) {
      existing =
        await env.DB.prepare(`
          SELECT
            id,
            admin_id,
            message,
            active,
            created_at

          FROM chat_announcements

          WHERE id = ?

          LIMIT 1
        `)
          .bind(
            announcementId
          )
          .first();
    } else {
      existing =
        await env.DB.prepare(`
          SELECT
            id,
            admin_id,
            message,
            active,
            created_at

          FROM chat_announcements

          WHERE active = 1

          ORDER BY
            created_at DESC,
            id DESC

          LIMIT 1
        `)
          .first();

      announcementId =
        existing?.id || null;
    }

    if (!existing) {
      return json({
        ok: false,
        error:
          "Ankündigung wurde nicht gefunden."
      }, 404);
    }

    if (
      !existing.active
    ) {
      return json({
        ok: true,

        already_inactive:
          true,

        announcement_id:
          existing.id
      });
    }

    await env.DB.prepare(`
      UPDATE chat_announcements

      SET active = 0

      WHERE id = ?
        AND active = 1
    `)
      .bind(
        existing.id
      )
      .run();

    await addModerationLog(
      env,
      user.id,
      "deactivate_announcement",
      {
        announcement_id:
          existing.id,

        message:
          existing.message
      }
    );

    return json({
      ok: true,

      announcement_id:
        existing.id,

      active:
        false
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht gelöscht werden."
    }, 500);
  }
}
