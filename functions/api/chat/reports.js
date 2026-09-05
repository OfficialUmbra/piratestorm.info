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
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(token, Math.floor(Date.now() / 1000))
    .first();
}

function isAdmin(user) {
  return user && user.role === "admin";
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

async function getChatMessage(env, messageId) {
  return await env.DB.prepare(`
    SELECT
      m.id,
      m.user_id,
      m.room_type,
      m.server,
      m.message,
      m.original_message,
      m.reply_to,
      m.created_at,
      m.deleted_at,

      u.username,
      u.server AS user_server,
      u.role
    FROM chat_messages m

    JOIN users u
      ON u.id = m.user_id

    WHERE m.id = ?
    LIMIT 1
  `)
    .bind(messageId)
    .first();
}

/*
 * Prüft, ob der aktuelle Nutzer die Nachricht überhaupt
 * sehen darf.
 *
 * Normale Nutzer:
 * - Globalchat
 * - eigener Serverchat
 *
 * Admin:
 * - Globalchat
 * - alle Serverchats
 */
function canUserSeeMessage(user, message) {
  if (!user || !message) {
    return false;
  }

  if (isAdmin(user)) {
    return true;
  }

  if (message.room_type === "global") {
    return true;
  }

  if (
    message.room_type === "server" &&
    message.server === user.server
  ) {
    return true;
  }

  return false;
}

/*
 * Holt für Umbra den Kontext einer gemeldeten Nachricht:
 *
 * 5 Nachrichten davor
 * + gemeldete Nachricht
 * + 5 Nachrichten danach
 *
 * Immer nur innerhalb desselben Chatraums.
 */
async function getContextMessages(env, message) {
  if (!message) {
    return [];
  }

  let beforeQuery;
  let afterQuery;
  let beforeBindings;
  let afterBindings;

  if (message.room_type === "global") {
    beforeQuery = `
      SELECT
        m.id,
        m.user_id,
        m.message,
        m.original_message,
        m.created_at,
        m.deleted_at,

        u.username,
        u.server AS user_server,
        u.role

      FROM chat_messages m

      JOIN users u
        ON u.id = m.user_id

      WHERE m.room_type = 'global'
        AND (
          m.created_at < ?
          OR (
            m.created_at = ?
            AND m.id < ?
          )
        )

      ORDER BY
        m.created_at DESC,
        m.id DESC

      LIMIT 5
    `;

    afterQuery = `
      SELECT
        m.id,
        m.user_id,
        m.message,
        m.original_message,
        m.created_at,
        m.deleted_at,

        u.username,
        u.server AS user_server,
        u.role

      FROM chat_messages m

      JOIN users u
        ON u.id = m.user_id

      WHERE m.room_type = 'global'
        AND (
          m.created_at > ?
          OR (
            m.created_at = ?
            AND m.id > ?
          )
        )

      ORDER BY
        m.created_at ASC,
        m.id ASC

      LIMIT 5
    `;

    beforeBindings = [
      message.created_at,
      message.created_at,
      message.id
    ];

    afterBindings = [
      message.created_at,
      message.created_at,
      message.id
    ];

  } else {
    beforeQuery = `
      SELECT
        m.id,
        m.user_id,
        m.message,
        m.original_message,
        m.created_at,
        m.deleted_at,

        u.username,
        u.server AS user_server,
        u.role

      FROM chat_messages m

      JOIN users u
        ON u.id = m.user_id

      WHERE m.room_type = 'server'
        AND m.server = ?
        AND (
          m.created_at < ?
          OR (
            m.created_at = ?
            AND m.id < ?
          )
        )

      ORDER BY
        m.created_at DESC,
        m.id DESC

      LIMIT 5
    `;

    afterQuery = `
      SELECT
        m.id,
        m.user_id,
        m.message,
        m.original_message,
        m.created_at,
        m.deleted_at,

        u.username,
        u.server AS user_server,
        u.role

      FROM chat_messages m

      JOIN users u
        ON u.id = m.user_id

      WHERE m.room_type = 'server'
        AND m.server = ?
        AND (
          m.created_at > ?
          OR (
            m.created_at = ?
            AND m.id > ?
          )
        )

      ORDER BY
        m.created_at ASC,
        m.id ASC

      LIMIT 5
    `;

    beforeBindings = [
      message.server,
      message.created_at,
      message.created_at,
      message.id
    ];

    afterBindings = [
      message.server,
      message.created_at,
      message.created_at,
      message.id
    ];
  }

  const beforeResult = await env.DB
    .prepare(beforeQuery)
    .bind(...beforeBindings)
    .all();

  const afterResult = await env.DB
    .prepare(afterQuery)
    .bind(...afterBindings)
    .all();

  const before =
    (beforeResult.results || []).reverse();

  const reportedMessage = {
    id: message.id,
    user_id: message.user_id,
    message: message.message,
    original_message: message.original_message,
    created_at: message.created_at,
    deleted_at: message.deleted_at,
    username: message.username,
    user_server: message.user_server,
    role: message.role
  };

  const after =
    afterResult.results || [];

  return [
    ...before,
    reportedMessage,
    ...after
  ].map(item => ({
    id: item.id,

    user: {
      id: item.user_id,
      username: item.username,
      server: item.user_server,
      server_code:
        getServerCode(item.user_server),
      role: item.role,
      is_admin:
        item.role === "admin"
    },

    message: item.message,

    /*
     * Nur Umbra kann diese API abrufen.
     * Deshalb darf hier auch der tatsächliche
     * Originaltext für die Moderation enthalten sein.
     */
    original_message:
      item.original_message,

    created_at:
      item.created_at,

    deleted:
      Boolean(item.deleted_at),

    is_reported_message:
      item.id === message.id
  }));
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Ein normaler eingeloggter Spieler meldet eine
 * Chatnachricht.
 *
 * WICHTIG:
 * Nachrichten eines Admin-Accounts können niemals
 * gemeldet werden.
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        ok: false,
        error: "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Ungültige Anfrage."
      }, 400);
    }

    const messageId =
      Number(body.message_id);

    if (
      !Number.isInteger(messageId) ||
      messageId <= 0
    ) {
      return json({
        ok: false,
        error: "Ungültige Nachrichten-ID."
      }, 400);
    }

    const message =
      await getChatMessage(
        env,
        messageId
      );

    if (!message) {
      return json({
        ok: false,
        error: "Nachricht wurde nicht gefunden."
      }, 404);
    }

    /*
     * Sicherheitsprüfung:
     * Man darf nur Nachrichten melden,
     * die man selbst sehen dürfte.
     */
    if (
      !canUserSeeMessage(
        user,
        message
      )
    ) {
      return json({
        ok: false,
        error:
          "Du darfst diese Nachricht nicht melden."
      }, 403);
    }

    /*
     * =================================================
     * ADMIN-SCHUTZ
     * =================================================
     *
     * Umbra bzw. jeder Account mit role = admin
     * kann NICHT gemeldet werden.
     *
     * Entscheidend ist NICHT der Spielername,
     * sondern ausschließlich die serverseitige Rolle.
     */
    if (message.role === "admin") {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht gemeldet werden."
      }, 403);
    }

    /*
     * Niemand kann seine eigene Nachricht melden.
     */
    if (message.user_id === user.id) {
      return json({
        ok: false,
        error:
          "Du kannst deine eigene Nachricht nicht melden."
      }, 400);
    }

    const reason =
      normalizeReason(body.reason);

    if (reason.length > 500) {
      return json({
        ok: false,
        error:
          "Der Meldegrund darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    /*
     * Dieselbe Nachricht kann vom selben Nutzer
     * nicht mehrfach offen gemeldet werden.
     */
    const existing =
      await env.DB.prepare(`
        SELECT id
        FROM chat_reports
        WHERE reporter_id = ?
          AND message_id = ?
          AND status IN (
            'open',
            'reviewed'
          )
        LIMIT 1
      `)
        .bind(
          user.id,
          messageId
        )
        .first();

    if (existing) {
      return json({
        ok: false,
        error:
          "Du hast diese Nachricht bereits gemeldet."
      }, 409);
    }

    const now =
      Math.floor(Date.now() / 1000);

    const result =
      await env.DB.prepare(`
        INSERT INTO chat_reports (
          reporter_id,
          reported_user_id,
          message_id,
          reason,
          status,
          created_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          'open',
          ?
        )
      `)
        .bind(
          user.id,
          message.user_id,
          messageId,
          reason || null,
          now
        )
        .run();

    return json({
      ok: true,

      report: {
        id:
          result.meta.last_row_id,

        message_id:
          messageId,

        status:
          "open",

        created_at:
          now
      },

      message:
        "Die Nachricht wurde gemeldet."
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Meldung konnte nicht erstellt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Ausschließlich Admin.
 *
 * Umbra bekommt:
 * - Meldung
 * - meldenden Spieler
 * - gemeldeten Spieler
 * - Originalnachricht
 * - Raum
 * - Server
 * - 5 Nachrichten davor
 * - 5 Nachrichten danach
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

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
          "Nur der Administrator darf Meldungen einsehen."
      }, 403);
    }

    const url =
      new URL(request.url);

    const status =
      url.searchParams.get("status") ||
      "open";

    const allowedStatuses = [
      "open",
      "reviewed",
      "closed",
      "all"
    ];

    if (
      !allowedStatuses.includes(status)
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Meldestatus."
      }, 400);
    }

    const limitRaw =
      Number(
        url.searchParams.get("limit") ||
        50
      );

    const limit =
      Math.max(
        1,
        Math.min(limitRaw, 100)
      );

    let query;
    let bindings;

    const baseQuery = `
      SELECT
        r.id,
        r.reporter_id,
        r.reported_user_id,
        r.message_id,
        r.reason,
        r.status,
        r.created_at,

        reporter.username
          AS reporter_username,

        reporter.server
          AS reporter_server,

        reported.username
          AS reported_username,

        reported.server
          AS reported_server,

        reported.role
          AS reported_role,

        m.room_type,

        m.server
          AS room_server,

        m.message,

        m.original_message,

        m.created_at
          AS message_created_at,

        m.deleted_at
          AS message_deleted_at

      FROM chat_reports r

      JOIN users reporter
        ON reporter.id =
          r.reporter_id

      JOIN users reported
        ON reported.id =
          r.reported_user_id

      LEFT JOIN chat_messages m
        ON m.id =
          r.message_id
    `;

    if (status === "all") {
      query = `
        ${baseQuery}

        ORDER BY
          CASE r.status
            WHEN 'open' THEN 1
            WHEN 'reviewed' THEN 2
            WHEN 'closed' THEN 3
            ELSE 4
          END,
          r.created_at DESC

        LIMIT ?
      `;

      bindings = [limit];

    } else {
      query = `
        ${baseQuery}

        WHERE r.status = ?

        ORDER BY
          r.created_at DESC

        LIMIT ?
      `;

      bindings = [
        status,
        limit
      ];
    }

    const result =
      await env.DB
        .prepare(query)
        .bind(...bindings)
        .all();

    const reports = [];

    for (
      const report
      of result.results || []
    ) {
      let contextMessages = [];

      if (report.message_id) {
        const originalMessage =
          await getChatMessage(
            env,
            report.message_id
          );

        if (originalMessage) {
          contextMessages =
            await getContextMessages(
              env,
              originalMessage
            );
        }
      }

      reports.push({
        id:
          report.id,

        status:
          report.status,

        reason:
          report.reason,

        created_at:
          report.created_at,

        reporter: {
          id:
            report.reporter_id,

          username:
            report.reporter_username,

          server:
            report.reporter_server,

          server_code:
            getServerCode(
              report.reporter_server
            )
        },

        reported_user: {
          id:
            report.reported_user_id,

          username:
            report.reported_username,

          server:
            report.reported_server,

          server_code:
            getServerCode(
              report.reported_server
            ),

          role:
            report.reported_role,

          is_admin:
            report.reported_role ===
            "admin"
        },

        room: {
          type:
            report.room_type,

          server:
            report.room_server,

          server_code:
            report.room_server
              ? getServerCode(
                  report.room_server
                )
              : null
        },

        reported_message:
          report.message_id
            ? {
                id:
                  report.message_id,

                visible_message:
                  report.message,

                original_message:
                  report.original_message,

                created_at:
                  report.message_created_at,

                deleted:
                  Boolean(
                    report.message_deleted_at
                  )
              }
            : null,

        context:
          contextMessages
      });
    }

    return json({
      ok: true,

      current_user: {
        id:
          user.id,

        username:
          user.username,

        role:
          user.role,

        is_admin:
          true
      },

      filter:
        status,

      reports
    });

  } catch (error) {
    console.error(
      "GET /api/chat/reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Meldungen konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Nur Admin.
 *
 * Meldestatus:
 * - open
 * - reviewed
 * - closed
 */
export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

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
          "Nur der Administrator darf Meldungen bearbeiten."
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

    const reportId =
      Number(body.id);

    if (
      !Number.isInteger(reportId) ||
      reportId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Meldungs-ID."
      }, 400);
    }

    const allowedStatuses = [
      "open",
      "reviewed",
      "closed"
    ];

    if (
      !allowedStatuses.includes(
        body.status
      )
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Meldestatus."
      }, 400);
    }

    const report =
      await env.DB.prepare(`
        SELECT
          id,
          reported_user_id,
          message_id,
          status
        FROM chat_reports
        WHERE id = ?
        LIMIT 1
      `)
        .bind(reportId)
        .first();

    if (!report) {
      return json({
        ok: false,
        error:
          "Meldung wurde nicht gefunden."
      }, 404);
    }

    /*
     * Zusätzlicher Schutz:
     * Falls irgendwann durch alte Daten eine Meldung
     * gegen einen Admin existieren sollte, darf sie
     * nicht als normale Moderationsmeldung verwendet
     * werden.
     */
    const reportedUser =
      await env.DB.prepare(`
        SELECT
          id,
          role
        FROM users
        WHERE id = ?
        LIMIT 1
      `)
        .bind(
          report.reported_user_id
        )
        .first();

    if (
      reportedUser &&
      reportedUser.role === "admin"
    ) {
      return json({
        ok: false,
        error:
          "Administratoren können nicht moderiert werden."
      }, 403);
    }

    await env.DB.prepare(`
      UPDATE chat_reports
      SET status = ?
      WHERE id = ?
    `)
      .bind(
        body.status,
        reportId
      )
      .run();

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
        user.id,
        report.reported_user_id,
        "update_report",
        JSON.stringify({
          report_id:
            reportId,

          message_id:
            report.message_id,

          old_status:
            report.status,

          new_status:
            body.status
        }),
        now
      )
      .run();

    return json({
      ok: true,

      report: {
        id:
          reportId,

        status:
          body.status
      },

      message:
        "Meldungsstatus wurde aktualisiert."
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Meldung konnte nicht aktualisiert werden."
    }, 500);
  }
}
