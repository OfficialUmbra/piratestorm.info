const MAX_ANNOUNCEMENT_LENGTH = 500;

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

function normalizeText(value) {
  if (typeof value !== "string") {
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
      JSON.stringify(details || {}),
      Math.floor(Date.now() / 1000)
    )
    .run();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Jeder eingeloggte Spieler darf die aktuell
 * aktive Admin-Ankündigung abrufen.
 *
 * Es wird ausschließlich die aktive Ankündigung
 * zurückgegeben.
 *
 * /api/chat/announcements
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

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

          u.role
            AS admin_role

        FROM chat_announcements a

        JOIN users u
          ON u.id = a.admin_id

        WHERE a.active = 1

        ORDER BY
          a.created_at DESC,
          a.id DESC

        LIMIT 1
      `)
        .first();

    if (!announcement) {
      return json({
        ok: true,
        announcement: null
      });
    }

    /*
     * Sicherheitscheck:
     *
     * Nur Ankündigungen eines echten Admin-Accounts
     * werden ausgeliefert.
     */
    if (
      announcement.admin_role !==
      "admin"
    ) {
      return json({
        ok: true,
        announcement: null
      });
    }

    return json({
      ok: true,

      announcement: {
        id:
          announcement.id,

        message:
          announcement.message,

        created_at:
          announcement.created_at,

        admin: {
          id:
            announcement.admin_id,

          username:
            announcement.admin_username,

          is_admin:
            true
        }
      }
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
 * Erstellt eine neue globale Chat-Ankündigung.
 *
 * Vorherige aktive Ankündigungen werden deaktiviert,
 * sodass immer nur EINE aktuelle Meldung existiert.
 *
 * Beispiel:
 *
 * {
 *   "message": "Serverwartung heute um 20:00 Uhr."
 * }
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

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
      normalizeText(
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
      MAX_ANNOUNCEMENT_LENGTH
    ) {
      return json({
        ok: false,
        error:
          `Die Ankündigung darf maximal ${MAX_ANNOUNCEMENT_LENGTH} Zeichen enthalten.`
      }, 400);
    }

    const now =
      Math.floor(Date.now() / 1000);

    /*
     * Immer nur eine aktive Ankündigung.
     */
    await env.DB.prepare(`
      UPDATE chat_announcements
      SET active = 0
      WHERE active = 1
    `)
      .run();

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
      "announcement",
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

        created_at:
          now,

        admin: {
          id:
            admin.id,

          username:
            admin.username,

          is_admin:
            true
        }
      },

      message:
        "Die Ankündigung wurde veröffentlicht."
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
 * Entfernt die aktuell aktive Ankündigung.
 *
 * Optional kann eine konkrete ID angegeben werden:
 *
 * /api/chat/announcements?id=5
 *
 * Ohne ID wird die derzeit aktive Ankündigung
 * entfernt.
 */
export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

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
          "Nur der Administrator darf Ankündigungen entfernen."
      }, 403);
    }

    const url =
      new URL(request.url);

    const idRaw =
      url.searchParams.get("id");

    let announcement;

    if (idRaw) {
      const id =
        Number(idRaw);

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
    } else {
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
          "Keine aktive Ankündigung gefunden."
      }, 404);
    }

    if (!announcement.active) {
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
      "announcement_delete",
      {
        announcement_id:
          announcement.id,

        message:
          announcement.message
      }
    );

    return json({
      ok: true,

      announcement_id:
        announcement.id,

      message:
        "Die Ankündigung wurde entfernt."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/announcements error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Ankündigung konnte nicht entfernt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Bewusst deaktiviert.
 *
 * Eine veröffentlichte Ankündigung wird nicht
 * nachträglich verändert. Stattdessen wird eine neue
 * erstellt. So bleibt das Moderationsprotokoll sauber.
 */
export async function onRequestPut() {
  return json({
    ok: false,
    error:
      "Ankündigungen können nicht nachträglich bearbeitet werden."
  }, 405);
}
