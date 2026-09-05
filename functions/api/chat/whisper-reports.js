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


/*
 * =====================================================
 * COOKIE
 * =====================================================
 */

function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get(
      "Cookie"
    ) || "";

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


/*
 * =====================================================
 * CURRENT USER
 * =====================================================
 */

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

  const now =
    Math.floor(
      Date.now() / 1000
    );

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
      now
    )
    .first();
}


/*
 * =====================================================
 * ROLES
 * =====================================================
 */

function isAdmin(user) {
  return Boolean(
    user &&
    user.role ===
    "admin"
  );
}


function isModerator(user) {
  return Boolean(
    user &&
    user.role ===
    "moderator"
  );
}


function canModerate(user) {
  return Boolean(
    user &&
    (
      isAdmin(user) ||
      isModerator(user)
    )
  );
}


/*
 * =====================================================
 * TEXT
 * =====================================================
 */

function normalizeReason(value) {
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


/*
 * =====================================================
 * POSITIVE INTEGER
 * =====================================================
 */

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
 * STAFF AUTH
 * =====================================================
 */

async function requireModerator(
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
      ok:
        false,

      response:
        json({
          ok:
            false,

          error:
            "Du musst eingeloggt sein."
        }, 401)
    };
  }

  if (
    !canModerate(
      user
    )
  ) {
    return {
      ok:
        false,

      response:
        json({
          ok:
            false,

          error:
            "Nur Administratoren und Moderatoren dürfen Whisper-Meldungen verwalten."
        }, 403)
    };
  }

  return {
    ok:
      true,

    user
  };
}


/*
 * =====================================================
 * TARGET PERMISSION
 * =====================================================
 *
 * Moderator:
 * -> nur normale User
 *
 * Admin:
 * -> User + Moderator
 *
 * Admin als Ziel:
 * -> niemals
 * =====================================================
 */

function canModerateTarget(
  actor,
  target
) {
  if (
    !actor ||
    !target
  ) {
    return false;
  }

  if (
    Number(actor.id) ===
    Number(target.id)
  ) {
    return false;
  }

  if (
    target.role ===
    "admin"
  ) {
    return false;
  }

  if (
    isModerator(actor)
  ) {
    return (
      target.role ===
      "user"
    );
  }

  if (
    isAdmin(actor)
  ) {
    return (
      target.role ===
        "user" ||
      target.role ===
        "moderator"
    );
  }

  return false;
}


/*
 * =====================================================
 * WHISPER ROOM MEMBERSHIP
 * =====================================================
 */

async function isRoomMember(
  env,
  roomId,
  userId
) {
  const member =
    await env.DB.prepare(`
      SELECT
        1 AS found

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

  return Boolean(
    member
  );
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
        targetUserId ||
        null,
        action,
        JSON.stringify(
          details ||
          {}
        ),
        Math.floor(
          Date.now() / 1000
        )
      )
      .run();

  } catch (error) {
    console.error(
      "Whisper moderation log error:",
      error
    );
  }
}


/*
 * =====================================================
 * WHISPER CONTEXT
 * =====================================================
 *
 * Nur über einen tatsächlichen Report erreichbar.
 *
 * Es werden geladen:
 *
 * 5 Nachrichten davor
 * gemeldete Nachricht
 * 5 Nachrichten danach
 * =====================================================
 */

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
        ON u.id =
          wm.user_id

      WHERE wm.room_id = ?
        AND wm.id < ?

      ORDER BY
        wm.id DESC

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
        ON u.id =
          wm.user_id

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
        ON u.id =
          wm.user_id

      WHERE wm.room_id = ?
        AND wm.id > ?

      ORDER BY
        wm.id ASC

      LIMIT 5
    `)
      .bind(
        roomId,
        messageId
      )
      .all();


  const rows = [
    ...(
      before.results ||
      []
    ).reverse(),

    ...(
      reported
        ? [reported]
        : []
    ),

    ...(
      after.results ||
      []
    )
  ];


  return rows.map(
    row => ({
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
          row.role ===
          "admin",

        is_moderator:
          row.role ===
          "moderator"
      },

      /*
       * Moderationskontext:
       *
       * original_message wird benutzt,
       * falls vorhanden.
       */
      message:
        row.original_message ||
        row.message,

      reply_to:
        row.reply_to,

      created_at:
        row.created_at,

      deleted:
        Boolean(
          row.deleted_at
        ),

      reported:
        Number(
          row.id
        ) ===
        Number(
          messageId
        )
    })
  );
}


/*
 * =====================================================
 * POST
 * =====================================================
 *
 * WHISPER-NACHRICHT MELDEN
 *
 * {
 *   "message_id": 123,
 *   "reason": "Beleidigung"
 * }
 *
 * Jeder eingeloggte Spieler darf melden.
 *
 * Voraussetzungen:
 *
 * - tatsächliches Mitglied des Raums
 * - nicht eigene Nachricht
 * - kein Admin als Ziel
 *
 * Moderator darf gemeldet werden.
 *
 * Diese Meldung sieht anschließend nur der Admin.
 * =====================================================
 */

export async function onRequestPost(
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
        ok:
          false,

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
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }


    const messageId =
      toPositiveInt(
        body.message_id
      );


    if (
      !messageId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Nachricht."
      }, 400);
    }


    const reason =
      normalizeReason(
        body.reason
      );


    if (
      !reason
    ) {
      return json({
        ok:
          false,

        error:
          "Bitte gib einen Grund für die Meldung an."
      }, 400);
    }


    if (
      reason.length >
      500
    ) {
      return json({
        ok:
          false,

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
          ON author.id =
            wm.user_id

        WHERE wm.id = ?

        LIMIT 1
      `)
        .bind(
          messageId
        )
        .first();


    if (
      !message
    ) {
      return json({
        ok:
          false,

        error:
          "Nachricht wurde nicht gefunden."
      }, 404);
    }


    if (
      message.deleted_at
    ) {
      return json({
        ok:
          false,

        error:
          "Gelöschte Nachrichten können nicht gemeldet werden."
      }, 409);
    }


    /*
     * =================================================
     * ROOM MEMBERSHIP
     * =================================================
     *
     * Auch Admin oder Moderator bekommen hier
     * keinen Sonderzugriff.
     */

    const member =
      await isRoomMember(
        env,
        message.room_id,
        user.id
      );


    if (
      !member
    ) {
      return json({
        ok:
          false,

        error:
          "Du kannst keine Nachricht aus diesem Whisper-Chat melden."
      }, 403);
    }


    /*
     * EIGENE NACHRICHT
     */

    if (
      Number(
        message.user_id
      ) ===
      Number(
        user.id
      )
    ) {
      return json({
        ok:
          false,

        error:
          "Du kannst deine eigene Nachricht nicht melden."
      }, 400);
    }


    /*
     * =================================================
     * ADMIN IMMUNITY
     * =================================================
     */

    if (
      message.role ===
      "admin"
    ) {
      return json({
        ok:
          false,

        error:
          "Der Administrator kann nicht gemeldet werden."
      }, 403);
    }


    /*
     * =================================================
     * DUPLIKAT
     * =================================================
     */

    const existing =
      await env.DB.prepare(`
        SELECT
          id

        FROM chat_reports

        WHERE reporter_id = ?
          AND whisper_message_id = ?
          AND report_type =
            'whisper'

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


    if (
      existing
    ) {
      return json({
        ok:
          false,

        error:
          "Du hast diese Nachricht bereits gemeldet."
      }, 409);
    }


    const now =
      Math.floor(
        Date.now() / 1000
      );


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
      ok:
        true,

      report: {
        id:
          result?.meta
            ?.last_row_id ||
          null,

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
            message.server,

          role:
            message.role,

          is_moderator:
            message.role ===
            "moderator"
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
      ok:
        false,

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
 * WHISPER-MELDUNGEN LADEN
 *
 * Moderator:
 * -> nur Reports gegen normale User
 *
 * Admin:
 * -> Reports gegen User + Moderatoren
 *
 * Admin-Reports:
 * -> niemals
 * =====================================================
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
      await requireModerator(
        request,
        env
      );


    if (
      !auth.ok
    ) {
      return auth.response;
    }


    const actor =
      auth.user;


    const url =
      new URL(
        request.url
      );


    const status =
      (
        url.searchParams.get(
          "status"
        ) ||
        "open"
      )
        .trim()
        .toLowerCase();


    if (
      ![
        "open",
        "reviewed",
        "closed",
        "all"
      ].includes(
        status
      )
    ) {
      return json({
        ok:
          false,

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

        reporter.role
          AS reporter_role,

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
        r.report_type =
          'whisper'
    `;


    const bindings =
      [];


    /*
     * STATUS FILTER
     */

    if (
      status !==
      "all"
    ) {
      query += `
        AND r.status = ?
      `;

      bindings.push(
        status
      );
    }


    /*
     * =================================================
     * STAFF HIERARCHY
     * =================================================
     */

    if (
      isModerator(
        actor
      )
    ) {
      query += `
        AND target.role = 'user'
      `;

    } else {
      query += `
        AND target.role != 'admin'
      `;
    }


    query += `
      ORDER BY
        r.created_at DESC,
        r.id DESC

      LIMIT 100
    `;


    const result =
      await env.DB
        .prepare(
          query
        )
        .bind(
          ...bindings
        )
        .all();


    const reports =
      [];


    for (
      const report
      of result.results ||
      []
    ) {
      /*
       * Zusätzlicher Schutz auch außerhalb
       * der SQL-Abfrage.
       */

      if (
        report.target_role ===
        "admin"
      ) {
        continue;
      }


      if (
        isModerator(
          actor
        ) &&
        report.target_role !==
        "user"
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
            report.reporter_server,

          role:
            report.reporter_role,

          is_admin:
            report.reporter_role ===
            "admin",

          is_moderator:
            report.reporter_role ===
            "moderator"
        },

        reported_user: {
          id:
            report.reported_user_id,

          username:
            report.target_username,

          server:
            report.target_server,

          role:
            report.target_role,

          is_admin:
            report.target_role ===
            "admin",

          is_moderator:
            report.target_role ===
            "moderator"
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
      ok:
        true,

      current_user: {
        id:
          actor.id,

        username:
          actor.username,

        server:
          actor.server,

        role:
          actor.role,

        is_admin:
          isAdmin(
            actor
          ),

        is_moderator:
          isModerator(
            actor
          )
      },

      filter:
        status,

      count:
        reports.length,

      reports
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whisper-reports error:",
      error
    );


    return json({
      ok:
        false,

      error:
        "Whisper-Meldungen konnten nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * REPORT-STATUS ÄNDERN
 *
 * {
 *   "report_id": 12,
 *   "status": "reviewed"
 * }
 *
 * Moderator:
 * -> nur User
 *
 * Admin:
 * -> User + Moderator
 * =====================================================
 */

export async function onRequestPut(
  context
) {
  try {
    const {
      request,
      env
    } = context;


    const auth =
      await requireModerator(
        request,
        env
      );


    if (
      !auth.ok
    ) {
      return auth.response;
    }


    const actor =
      auth.user;


    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }


    const reportId =
      toPositiveInt(
        body.report_id ||
        body.id
      );


    const status =
      typeof body.status ===
      "string"
        ? body.status
            .trim()
            .toLowerCase()
        : "";


    if (
      !reportId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Meldung."
      }, 400);
    }


    if (
      ![
        "open",
        "reviewed",
        "closed"
      ].includes(
        status
      )
    ) {
      return json({
        ok:
          false,

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
        .bind(
          reportId
        )
        .first();


    if (
      !report
    ) {
      return json({
        ok:
          false,

        error:
          "Whisper-Meldung wurde nicht gefunden."
      }, 404);
    }


    const target = {
      id:
        report.reported_user_id,

      username:
        report.username,

      server:
        report.server,

      role:
        report.role
    };


    /*
     * =================================================
     * HIERARCHY
     * =================================================
     */

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      if (
        target.role ===
        "admin"
      ) {
        return json({
          ok:
            false,

          error:
            "Der Administrator kann nicht moderiert werden."
        }, 403);
      }


      if (
        isModerator(
          actor
        ) &&
        target.role ===
        "moderator"
      ) {
        return json({
          ok:
            false,

          error:
            "Whisper-Meldungen gegen Moderatoren können nur vom Administrator bearbeitet werden."
        }, 403);
      }


      return json({
        ok:
          false,

        error:
          "Du darfst diese Whisper-Meldung nicht bearbeiten."
      }, 403);
    }


    /*
     * Keine Änderung.
     */

    if (
      report.status ===
      status
    ) {
      return json({
        ok:
          true,

        unchanged:
          true,

        report: {
          id:
            report.id,

          status
        }
      });
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
      actor.id,
      report.reported_user_id,
      "whisper_report_status",
      {
        report_id:
          report.id,

        whisper_message_id:
          report.whisper_message_id,

        actor_role:
          actor.role,

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
      ok:
        true,

      unchanged:
        false,

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
      ok:
        false,

      error:
        "Die Whisper-Meldung konnte nicht aktualisiert werden."
    }, 500);
  }
}


/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * GEMELDETE WHISPER-NACHRICHT LÖSCHEN
 *
 * Request:
 *
 * {
 *   "report_id": 12
 * }
 *
 * Wichtig:
 *
 * Die private Nachricht wird ausschließlich über
 * die Report-ID serverseitig ermittelt.
 *
 * Ein Moderator kann dadurch NICHT einfach eine
 * beliebige Whisper-Nachricht-ID übergeben.
 * =====================================================
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
      await requireModerator(
        request,
        env
      );


    if (
      !auth.ok
    ) {
      return auth.response;
    }


    const actor =
      auth.user;


    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }


    const reportId =
      toPositiveInt(
        body.report_id ||
        body.id
      );


    if (
      !reportId
    ) {
      return json({
        ok:
          false,

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
        .bind(
          reportId
        )
        .first();


    if (
      !report
    ) {
      return json({
        ok:
          false,

        error:
          "Whisper-Meldung wurde nicht gefunden."
      }, 404);
    }


    const target = {
      id:
        report.reported_user_id,

      username:
        report.username,

      server:
        report.server,

      role:
        report.role
    };


    /*
     * =================================================
     * HIERARCHY
     * =================================================
     */

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      if (
        target.role ===
        "admin"
      ) {
        return json({
          ok:
            false,

          error:
            "Nachrichten des Administrators können nicht über Meldungen moderiert werden."
        }, 403);
      }


      if (
        isModerator(
          actor
        ) &&
        target.role ===
        "moderator"
      ) {
        return json({
          ok:
            false,

          error:
            "Nachrichten anderer Moderatoren können nur vom Administrator moderiert werden."
        }, 403);
      }


      return json({
        ok:
          false,

        error:
          "Du darfst diese Nachricht nicht moderieren."
      }, 403);
    }


    /*
     * Bereits gelöscht.
     */

    if (
      report.deleted_at
    ) {
      return json({
        ok:
          false,

        error:
          "Diese Nachricht wurde bereits gelöscht."
      }, 409);
    }


    const now =
      Math.floor(
        Date.now() / 1000
      );


    /*
     * =================================================
     * SOFT DELETE
     * =================================================
     */

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


    /*
     * Report gleichzeitig schließen.
     */

    await env.DB.prepare(`
      UPDATE chat_reports

      SET status =
        'closed'

      WHERE id = ?

        AND report_type =
          'whisper'
    `)
      .bind(
        report.id
      )
      .run();


    /*
     * =================================================
     * LOG
     * =================================================
     */

    await addModerationLog(
      env,
      actor.id,
      report.reported_user_id,
      "delete_reported_whisper_message",
      {
        report_id:
          report.id,

        whisper_message_id:
          report.whisper_message_id,

        room_id:
          report.room_id,

        actor_role:
          actor.role,

        username:
          report.username,

        server:
          report.server
      }
    );


    return json({
      ok:
        true,

      report_id:
        report.id,

      whisper_message_id:
        report.whisper_message_id,

      closed:
        true,

      message:
        "Die gemeldete Whisper-Nachricht wurde gelöscht."
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/whisper-reports error:",
      error
    );


    return json({
      ok:
        false,

      error:
        "Die gemeldete Whisper-Nachricht konnte nicht gelöscht werden."
    }, 500);
  }
}
