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

function safeParseDetails(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    if (
      parsed &&
      typeof parsed === "object"
    ) {
      return parsed;
    }

    return {
      value: parsed
    };
  } catch {
    /*
     * Falls ein älterer Eintrag kein JSON enthält,
     * geht das Protokoll trotzdem nicht kaputt.
     */
    return {
      text: value
    };
  }
}

function getActionLabel(action) {
  const labels = {
    kick:
      "Spieler gekickt",

    ban:
      "Spieler gebannt",

    unban:
      "Bann aufgehoben",

    delete_message:
      "Chatnachricht gelöscht",

    message_delete:
      "Chatnachricht gelöscht",

    delete_chat_message:
      "Chatnachricht gelöscht",

    whisper_message_delete:
      "Whisper-Nachricht gelöscht",

    report_status:
      "Meldestatus geändert",

    whisper_report_status:
      "Whisper-Meldestatus geändert",

    announcement:
      "Ankündigung erstellt",

    announcement_delete:
      "Ankündigung entfernt"
  };

  return labels[action] || action;
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Ausschließlich Admin.
 *
 * Beispiele:
 *
 * /api/chat/modlog
 *
 * /api/chat/modlog?limit=50
 *
 * /api/chat/modlog?action=ban
 *
 * /api/chat/modlog?user_id=12
 *
 * Kombinationen sind ebenfalls möglich:
 *
 * /api/chat/modlog?action=ban&user_id=12&limit=25
 */
export async function onRequestGet(context) {
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

    /*
     * Server-seitiger Adminschutz.
     *
     * Manipulation des Frontends oder der URL
     * reicht nicht aus, um das Protokoll zu sehen.
     */
    if (!isAdmin(admin)) {
      return json({
        ok: false,
        error:
          "Nur der Administrator darf das Moderationsprotokoll ansehen."
      }, 403);
    }

    const url =
      new URL(request.url);

    /*
     * Maximal 200 Einträge pro Anfrage.
     */
    const requestedLimit =
      Number(
        url.searchParams.get("limit") ||
        100
      );

    const limit =
      Number.isFinite(requestedLimit)
        ? Math.max(
            1,
            Math.min(
              Math.floor(requestedLimit),
              200
            )
          )
        : 100;

    const action =
      (
        url.searchParams.get("action") ||
        ""
      ).trim();

    const targetUserRaw =
      url.searchParams.get("user_id");

    let targetUserId = null;

    if (
      targetUserRaw !== null &&
      targetUserRaw !== ""
    ) {
      targetUserId =
        Number(targetUserRaw);

      if (
        !Number.isInteger(targetUserId) ||
        targetUserId <= 0
      ) {
        return json({
          ok: false,
          error:
            "Ungültige Spieler-ID."
        }, 400);
      }
    }

    let query = `
      SELECT
        log.id,
        log.admin_id,
        log.target_user_id,
        log.action,
        log.details,
        log.created_at,

        admin.username
          AS admin_username,

        admin.server
          AS admin_server,

        admin.role
          AS admin_role,

        target.username
          AS target_username,

        target.server
          AS target_server,

        target.role
          AS target_role

      FROM chat_moderation_log log

      JOIN users admin
        ON admin.id =
          log.admin_id

      LEFT JOIN users target
        ON target.id =
          log.target_user_id

      WHERE 1 = 1
    `;

    const bindings = [];

    if (action) {
      query += `
        AND log.action = ?
      `;

      bindings.push(action);
    }

    if (targetUserId !== null) {
      query += `
        AND log.target_user_id = ?
      `;

      bindings.push(targetUserId);
    }

    query += `
      ORDER BY
        log.created_at DESC,
        log.id DESC

      LIMIT ?
    `;

    bindings.push(limit);

    const result =
      await env.DB
        .prepare(query)
        .bind(...bindings)
        .all();

    const entries =
      (result.results || []).map(
        entry => {
          const details =
            safeParseDetails(
              entry.details
            );

          return {
            id:
              entry.id,

            action:
              entry.action,

            action_label:
              getActionLabel(
                entry.action
              ),

            admin: {
              id:
                entry.admin_id,

              username:
                entry.admin_username,

              server:
                entry.admin_server,

              role:
                entry.admin_role,

              is_admin:
                entry.admin_role ===
                "admin"
            },

            target:
              entry.target_user_id
                ? {
                    id:
                      entry.target_user_id,

                    username:
                      entry.target_username,

                    server:
                      entry.target_server,

                    role:
                      entry.target_role,

                    is_admin:
                      entry.target_role ===
                      "admin"
                  }
                : null,

            details,

            created_at:
              entry.created_at
          };
        }
      );

    return json({
      ok: true,

      filters: {
        action:
          action || null,

        user_id:
          targetUserId,

        limit
      },

      count:
        entries.length,

      entries
    });

  } catch (error) {
    console.error(
      "GET /api/chat/modlog error:",
      error
    );

    return json({
      ok: false,
      error:
        "Das Moderationsprotokoll konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Nicht erlaubt.
 *
 * Moderationseinträge dürfen ausschließlich durch
 * unsere serverseitigen Moderationsfunktionen erzeugt
 * werden, z. B.:
 *
 * - Ban
 * - Unban
 * - Kick
 * - Nachricht löschen
 * - Report bearbeiten
 *
 * So kann selbst ein Admin nicht über den Browser
 * beliebige Fake-Logeinträge erzeugen.
 */
export async function onRequestPost() {
  return json({
    ok: false,
    error:
      "Moderationseinträge können nicht manuell erstellt werden."
  }, 405);
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Logs sind unveränderbar.
 */
export async function onRequestPut() {
  return json({
    ok: false,
    error:
      "Moderationseinträge können nicht verändert werden."
  }, 405);
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Logs werden nicht über die API gelöscht.
 *
 * Damit bleibt nachvollziehbar, welche
 * Moderationsaktionen durchgeführt wurden.
 */
export async function onRequestDelete() {
  return json({
    ok: false,
    error:
      "Moderationseinträge können nicht gelöscht werden."
  }, 405);
}
