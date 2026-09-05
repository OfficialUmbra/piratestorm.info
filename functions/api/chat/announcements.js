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

async function getCurrentUser(
  request,
  env
) {
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

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function normalizeMessage(value) {
  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

async function addModerationLog(
  env,
  adminId,
  action,
  details
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

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
      JSON.stringify(
        details || {}
      ),
      now
    )
    .run();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Lädt die aktuell aktive Ankündigung.
 *
 * Jeder eingeloggte Spieler darf die aktive
 * Ankündigung sehen.
 *
 * Optional für Admin:
 *
 * /api/chat/announcements?all=1
 *
 * Dann werden auch ältere/inaktive
 * Ankündigungen geladen.
 */
export async function onRequestGet(
  context
) {
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
      new URL(
        request.url
      );

    const showAll =
      url.searchParams.get(
        "all"
      ) === "1";

    /*
     * Nur Admin darf die komplette Historie
     * sehen.
     */
    if (
      showAll &&
      !isAdmin(user)
    ) {
      return json({
        ok: false,
        error:
          "Nur der Administrator darf alle Ankündigungen einsehen."
      }, 403);
    }

    /*
     * =============================================
     * ADMIN-HISTORIE
     * =============================================
     */
    if (showAll) {
      const limitRaw =
        Number(
          url.searchParams.get(
            "limit"
          ) || 100
        );

      const limit =
        Number.isFinite(
          limitRaw
        )
          ? Math.max(
              1,
              Math.min(
                Math.floor(
                  limitRaw
                ),
                200
              )
            )
          : 100;

      const result =
        await env.DB.prepare(`
          SELECT
            a.id,
            a.admin_id,
            a.message,
            a.active,
            a.created_at,

            u.username
              AS admin_username,

            u.server
              AS admin_server,

            u.role
              AS admin_role

          FROM chat_announcements a

          JOIN users u
            ON u.id =
              a.admin_id

          ORDER BY
            a.created_at DESC,
            a.id DESC

          LIMIT ?
        `)
          .bind(limit)
          .all();

      const announcements =
        (
          result.results ||
          []
        ).map(
          announcement => ({
            id:
              announcement.id,

            message:
              announcement.message,

            active:
              Boolean(
                announcement.active
              ),

            created_at:
              announcement.created_at,

            admin: {
              id:
                announcement.admin_id,

              username:
                announcement.admin_username,

              server:
                announcement.admin_server,

              role:
                announcement.admin_role,

              is_admin:
                announcement.admin_role ===
                "admin"
            }
          })
        );

      return json({
        ok: true,

        current_user: {
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

        count:
          announcements.length,

        announcements
      });
    }

    /*
     * =============================================
     * AKTUELLE ANKÜNDIGUNG
     * =============================================
     *
     * Es sollte normalerweise nur eine aktive
     * Ankündigung geben.
     *
     * Sicherheitshalber nehmen wir immer die
     * neueste aktive.
     */
    const announcement =
      await env.DB.prepare(`
        SELECT
          a.id,
          a.admin_id,
          a.message,
          a.active,
          a.created_at,

          u.username
            AS admin_username,

          u.server
            AS admin_server,

          u.role
            AS admin_role

        FROM chat_announcements a

        JOIN users u
          ON u.id =
            a.admin_id

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

              message:
                announcement.message,

              active:
                true,

              created_at:
                announcement.created_at,

              admin: {
                id:
                  announcement.admin_id,

                username:
                  announcement.admin_username,

                server:
                  announcement.admin_server,

                role:
                  announcement.admin_role,

                is_admin:
                  announcement.admin_role ===
                  "admin"
              }
            }
          : null
    });

  } catch (error) {
    console.error(
      "GET /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht geladen werden."
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
 * Erstellt eine neue Ankündigung.
 *
 * {
 *   "message": "Willkommen im Chat!"
 * }
 *
 * Vorherige aktive Ankündigungen werden automatisch
 * deaktiviert.
 */
export async function onRequestPost(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const admin =
      await getCurrentUser(
        request,
        env
      );

    if (!admin) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    if (!isAdmin(admin)) {
      return json({
        ok: false,
        error:
          "Nur der Administrator darf Ankündigungen erstellen."
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
      normalizeMessage(
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
      message.length >
      500
    ) {
      return json({
        ok: false,
        error:
          "Die Ankündigung darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * Vorhandene aktive Ankündigungen deaktivieren.
     */
    await env.DB.prepare(`
      UPDATE chat_announcements

      SET active = 0

      WHERE active = 1
    `)
      .run();

    /*
     * Neue Ankündigung erstellen.
     */
    const result =
      await env.DB.prepare(`
        INSERT INTO chat_announcements (
          admin_id,
          message,
          active,
          created_at
        )

        VALUES (?, ?, 1, ?)
      `)
        .bind(
          admin.id,
          message,
          now
        )
        .run();

    const announcementId =
      result.meta.last_row_id;

    await addModerationLog(
      env,
      admin.id,
      "create_announcement",
      {
        announcement_id:
          announcementId,

        message
      }
    );

    return json({
      ok: true,

      announcement: {
        id:
          announcementId,

        message,

        active:
          true,

        created_at:
          now,

        admin: {
          id:
            admin.id,

          username:
            admin.username,

          server:
            admin.server,

          role:
            admin.role,

          is_admin:
            true
        }
      },

      message:
        "Ankündigung wurde veröffentlicht."
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht veröffentlicht werden."
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
 * Deaktiviert eine Ankündigung.
 *
 * Möglich:
 *
 * DELETE /api/chat/announcements?id=5
 *
 * Ohne ID wird die aktuell aktive Ankündigung
 * deaktiviert.
 */
export async function onRequestDelete(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const admin =
      await getCurrentUser(
        request,
        env
      );

    if (!admin) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    if (!isAdmin(admin)) {
      return json({
        ok: false,
        error:
          "Nur der Administrator darf Ankündigungen deaktivieren."
      }, 403);
    }

    const url =
      new URL(
        request.url
      );

    const rawId =
      url.searchParams.get(
        "id"
      );

    let announcement;

    /*
     * =============================================
     * BESTIMMTE ANKÜNDIGUNG
     * =============================================
     */
    if (
      rawId !== null &&
      rawId !== ""
    ) {
      const id =
        Number(rawId);

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return json({
          ok: false,
          error:
            "Ungültige Ankündigungs-ID."
        }, 400);
      }

      announcement =
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
          .bind(id)
          .first();
    }

    /*
     * =============================================
     * AKTUELL AKTIVE ANKÜNDIGUNG
     * =============================================
     */
    else {
      announcement =
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
    }

    if (!announcement) {
      return json({
        ok: false,
        error:
          "Ankündigung wurde nicht gefunden."
      }, 404);
    }

    if (
      !announcement.active
    ) {
      return json({
        ok: false,
        error:
          "Diese Ankündigung ist bereits inaktiv."
      }, 409);
    }

    await env.DB.prepare(`
      UPDATE chat_announcements

      SET active = 0

      WHERE id = ?
    `)
      .bind(
        announcement.id
      )
      .run();

    await addModerationLog(
      env,
      admin.id,
      "deactivate_announcement",
      {
        announcement_id:
          announcement.id,

        message:
          announcement.message
      }
    );

    return json({
      ok: true,

      announcement: {
        id:
          announcement.id,

        active:
          false
      },

      message:
        "Ankündigung wurde deaktiviert."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht deaktiviert werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Direkte Bearbeitung ist bewusst deaktiviert.
 *
 * Neue Ankündigung erstellen statt alte verändern,
 * damit das Moderationsprotokoll nachvollziehbar
 * bleibt.
 */
export async function onRequestPut() {
  return json({
    ok: false,
    error:
      "Ankündigungen können nicht direkt bearbeitet werden. Erstelle stattdessen eine neue Ankündigung."
  }, 405);
}
