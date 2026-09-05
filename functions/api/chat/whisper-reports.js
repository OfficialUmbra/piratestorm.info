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
    WHERE sessions.id = ?
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

function normalizeReason(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

async function isRoomMember(
  env,
  roomId,
  userId
) {
  const member =
    await env.DB.prepare(`
      SELECT 1 AS found
      FROM whisper_members
      WHERE room_id = ?
        AND user_id = ?
      LIMIT 1
    `)
      .bind(
        roomId,
        userId
      )
      .first();

  return Boolean(member);
}

async function addModerationLog(
  env,
  adminId,
  targetUserId,
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
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(
      adminId,
      targetUserId,
      action,
      JSON.stringify(details || {}),
      Math.floor(Date.now() / 1000)
    )
    .run();
}

async function getWhisperContext(
  env,
  roomId,
  messageId
) {
  const before =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.room_id,
        wm.user_id,
        wm.message,
        wm.original_message,
        wm.reply_to,
        wm.created_at,
        wm.deleted_at,

        u.username,
        u.server,
        u.role

      FROM whisper_messages wm

      JOIN users u
        ON u.id = wm.user_id

      WHERE wm.room_id = ?
        AND wm.id < ?

      ORDER BY wm.id DESC

      LIMIT 5
    `)
      .bind(
        roomId,
        messageId
      )
      .all();

  const reported =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.room_id,
        wm.user_id,
        wm.message,
        wm.original_message,
        wm.reply_to,
        wm.created_at,
        wm.deleted_at,

        u.username,
        u.server,
        u.role

      FROM whisper_messages wm

      JOIN users u
        ON u.id = wm.user_id

      WHERE wm.room_id = ?
        AND wm.id = ?

      LIMIT 1
    `)
      .bind(
        roomId,
        messageId
      )
      .first();

  const after =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.room_id,
        wm.user_id,
        wm.message,
        wm.original_message,
        wm.reply_to,
        wm.created_at,
        wm.deleted_at,

        u.username,
        u.server,
        u.role

      FROM whisper_messages wm

      JOIN users u
        ON u.id = wm.user_id

      WHERE wm.room_id = ?
        AND wm.id > ?

      ORDER BY wm.id ASC

      LIMIT 5
    `)
      .bind(
        roomId,
        messageId
      )
      .all();

  const rows = [
    ...(before.results || []).reverse(),
    ...(reported ? [reported] : []),
    ...(after.results || [])
  ];

  return rows.map(row => ({
    id:
      row.id,

    room_id:
      row.room_id,

    user: {
      id:
        row.user_id,

      username:
        row.username,

      server:
        row.server,

      role:
        row.role,

      is_admin:
        row.role === "admin"
    },

    message:
      row.original_message ||
      row.message,

    reply_to:
      row.reply_to,

    created_at:
      row.created_at,

    deleted:
      Boolean(row.deleted_at),

    reported:
      row.id === messageId
  }));
}

/*
 * WHISPER-NACHRICHT MELDEN
 */
export async function onRequestPost(context) {
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

    const messageId =
      Number(body.message_id);

    if (
      !Number.isInteger(messageId) ||
      messageId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Nachricht."
      }, 400);
    }

    const reason =
      normalizeReason(
        body.reason
      );

    if (!reason) {
      return json({
        ok: false,
        error:
          "Bitte gib einen Grund für die Meldung an."
      }, 400);
    }

    if (reason.length > 500) {
      return json({
        ok: false,
        error:
          "Der Meldegrund darf maximal 500 Zeichen enthalten."
      }, 400);
    }

    const message =
      await env.DB.prepare(`
        SELECT
          wm.id,
          wm.room_id,
          wm.user_id,
          wm.message,
          wm.original_message,
          wm.deleted_at,

          author.username,
          author.server,
          author.role

        FROM whisper_messages wm

        JOIN users author
          ON author.id = wm.user_id

        WHERE wm.id = ?

        LIMIT 1
      `)
        .bind(messageId)
        .first();

    if (!message) {
      return json({
        ok: false,
        error:
          "Nachricht wurde nicht gefunden."
      }, 404);
    }

    const member =
      await isRoomMember(
        env,
        message.room_id,
        user.id
      );

    if (!member) {
      return json({
        ok: false,
        error:
          "Du kannst keine Nachricht aus diesem Whisper-Chat melden."
      }, 403);
    }

    if (message.user_id === user.id) {
      return json({
        ok: false,
        error:
          "Du kannst deine eigene Nachricht nicht melden."
      }, 400);
    }

    if (message.role === "admin") {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht gemeldet werden."
      }, 403);
    }

    const existing =
      await env.DB.prepare(`
        SELECT id
        FROM chat_reports
        WHERE reporter_id = ?
          AND whisper_message_id = ?
          AND report_type = 'whisper'
          AND status IN (
            'open',
            'reviewed'
          )
        LIMIT 1
      `)
        .bind(
          user.id,
          message.id
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
          whisper_message_id,
          report_type,
          reason,
          status,
          created_at
        )
        VALUES (
          ?,
          ?,
          NULL,
          ?,
          'whisper',
          ?,
          'open',
          ?
        )
      `)
        .bind(
          user.id,
          message.user_id,
          message.id,
          reason,
          now
        )
        .run();

    return json({
      ok: true,

      report: {
        id:
          result.meta.last_row_id,

        type:
          "whisper",

        message_id:
          message.id,

        reported_user: {
          id:
            message.user_id,

          username:
            message.username,

          server:
            message.server
        },

        reason,

        status:
          "open",

        created_at:
          now
      },

      message:
        "Die Whisper-Nachricht wurde gemeldet."
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/whisper-reports error:",
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
 * ADMIN: WHISPER-MELDUNGEN LADEN
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

    if (!isAdmin(user)) {
      return json({
        ok: false,
        error:
          "Nur der Administrator darf Whisper-Meldungen ansehen."
      }, 403);
    }

    const url =
      new URL(request.url);

    const status =
      url.searchParams.get(
        "status"
      ) || "open";

    if (
      ![
        "open",
        "reviewed",
        "closed",
        "all"
      ].includes(status)
    ) {
      return json({
        ok: false,
        error:
          "Ungültiger Statusfilter."
      }, 400);
    }

    let query = `
      SELECT
        r.id,
        r.reporter_id,
        r.reported_user_id,
        r.whisper_message_id,
        r.reason,
        r.status,
        r.created_at,

        reporter.username
          AS reporter_username,

        reporter.server
          AS reporter_server,

        target.username
          AS target_username,

        target.server
          AS target_server,

        target.role
          AS target_role,

        wm.room_id,
        wm.message,
        wm.original_message,
        wm.created_at
          AS message_created_at,
        wm.deleted_at

      FROM chat_reports r

      JOIN users reporter
        ON reporter.id =
          r.reporter_id

      JOIN users target
        ON target.id =
          r.reported_user_id

      JOIN whisper_messages wm
        ON wm.id =
          r.whisper_message_id

      WHERE
        r.report_type = 'whisper'
    `;

    const bindings = [];

    if (status !== "all") {
      query += `
        AND r.status = ?
      `;

      bindings.push(status);
    }

    query += `
      ORDER BY
        r.created_at DESC

      LIMIT 100
    `;

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
      if (
        report.target_role ===
        "admin"
      ) {
        continue;
      }

      const contextMessages =
        await getWhisperContext(
          env,
          report.room_id,
          report.whisper_message_id
        );

      reports.push({
        id:
          report.id,

        type:
          "whisper",

        reporter: {
          id:
            report.reporter_id,

          username:
            report.reporter_username,

          server:
            report.reporter_server
        },

        reported_user: {
          id:
            report.reported_user_id,

          username:
            report.target_username,

          server:
            report.target_server
        },

        room_id:
          report.room_id,

        message: {
          id:
            report.whisper_message_id,

          text:
            report.original_message ||
            report.message,

          created_at:
            report.message_created_at,

          deleted:
            Boolean(
              report.deleted_at
            )
        },

        reason:
          report.reason,

        status:
          report.status,

        created_at:
          report.created_at,

        context:
          contextMessages
      });
    }

    return json({
      ok: true,
      filter:
        status,
      reports
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whisper-reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Whisper-Meldungen konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * ADMIN: REPORT-STATUS ÄNDERN
 */
export async function onRequestPut(context) {
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
      Number(body.report_id);

    const status =
      typeof body.status === "string"
        ? body.status.toLowerCase()
        : "";

    if (
      !Number.isInteger(reportId) ||
      reportId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Meldung."
      }, 400);
    }

    if (
      ![
        "open",
        "reviewed",
        "closed"
      ].includes(status)
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
          r.id,
          r.reported_user_id,
          r.whisper_message_id,
          r.status,

          u.username,
          u.server,
          u.role

        FROM chat_reports r

        JOIN users u
          ON u.id =
            r.reported_user_id

        WHERE r.id = ?
          AND r.report_type =
            'whisper'

        LIMIT 1
      `)
        .bind(reportId)
        .first();

    if (!report) {
      return json({
        ok: false,
        error:
          "Whisper-Meldung wurde nicht gefunden."
      }, 404);
    }

    if (report.role === "admin") {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht moderiert werden."
      }, 403);
    }

    await env.DB.prepare(`
      UPDATE chat_reports
      SET status = ?
      WHERE id = ?
        AND report_type =
          'whisper'
    `)
      .bind(
        status,
        report.id
      )
      .run();

    await addModerationLog(
      env,
      admin.id,
      report.reported_user_id,
      "whisper_report_status",
      {
        report_id:
          report.id,

        whisper_message_id:
          report.whisper_message_id,

        username:
          report.username,

        server:
          report.server,

        previous_status:
          report.status,

        new_status:
          status
      }
    );

    return json({
      ok: true,

      report: {
        id:
          report.id,

        status
      },

      message:
        "Status der Whisper-Meldung wurde aktualisiert."
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/whisper-reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Whisper-Meldung konnte nicht aktualisiert werden."
    }, 500);
  }
}

/*
 * ADMIN: GEMELDETE WHISPER-NACHRICHT LÖSCHEN
 *
 * Wichtig:
 * Der Admin übergibt ausschließlich die Report-ID.
 * Die zugehörige private Nachricht wird serverseitig
 * über die Meldung ermittelt.
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
          "Nur der Administrator darf gemeldete Whisper-Nachrichten löschen."
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
      Number(body.report_id);

    if (
      !Number.isInteger(reportId) ||
      reportId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Meldung."
      }, 400);
    }

    const report =
      await env.DB.prepare(`
        SELECT
          r.id,
          r.reported_user_id,
          r.whisper_message_id,
          r.status,

          target.username,
          target.server,
          target.role,

          wm.room_id,
          wm.deleted_at

        FROM chat_reports r

        JOIN users target
          ON target.id =
            r.reported_user_id

        JOIN whisper_messages wm
          ON wm.id =
            r.whisper_message_id

        WHERE r.id = ?
          AND r.report_type =
            'whisper'

        LIMIT 1
      `)
        .bind(reportId)
        .first();

    if (!report) {
      return json({
        ok: false,
        error:
          "Whisper-Meldung wurde nicht gefunden."
      }, 404);
    }

    if (report.role === "admin") {
      return json({
        ok: false,
        error:
          "Nachrichten des Administrators können nicht über Meldungen moderiert werden."
      }, 403);
    }

    if (report.deleted_at) {
      return json({
        ok: false,
        error:
          "Diese Nachricht wurde bereits gelöscht."
      }, 409);
    }

    const now =
      Math.floor(Date.now() / 1000);

    await env.DB.prepare(`
      UPDATE whisper_messages
      SET deleted_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
    `)
      .bind(
        now,
        report.whisper_message_id
      )
      .run();

    await env.DB.prepare(`
      UPDATE chat_reports
      SET status = 'closed'
      WHERE id = ?
        AND report_type = 'whisper'
    `)
      .bind(report.id)
      .run();

    await addModerationLog(
      env,
      admin.id,
      report.reported_user_id,
      "delete_reported_whisper_message",
      {
        report_id:
          report.id,

        whisper_message_id:
          report.whisper_message_id,

        room_id:
          report.room_id,

        username:
          report.username,

        server:
          report.server
      }
    );

    return json({
      ok: true,

      report_id:
        report.id,

      whisper_message_id:
        report.whisper_message_id,

      message:
        "Die gemeldete Whisper-Nachricht wurde gelöscht."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/whisper-reports error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die gemeldete Whisper-Nachricht konnte nicht gelöscht werden."
    }, 500);
  }
}
