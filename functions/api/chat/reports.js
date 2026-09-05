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
 * TEXT / ID
 * =====================================================
 */

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
 * CURRENT USER
 * =====================================================
 */

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
            "Nur Administratoren und Moderatoren dürfen Meldungen verwalten."
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
 * USER
 * =====================================================
 */

async function getUserById(
  env,
  userId
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
    .bind(
      userId
    )
    .first();
}


/*
 * =====================================================
 * STAFF -> TARGET
 * =====================================================
 *
 * Admin:
 * User + Moderator
 *
 * Moderator:
 * nur User
 *
 * Admin als Ziel:
 * niemals
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
 * PUBLIC MESSAGE
 * =====================================================
 */

async function getPublicMessage(
  env,
  messageId
) {
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
      u.server
        AS user_server,
      u.role

    FROM chat_messages m

    JOIN users u
      ON u.id =
        m.user_id

    WHERE m.id = ?

    LIMIT 1
  `)
    .bind(
      messageId
    )
    .first();
}


/*
 * =====================================================
 * WHISPER MESSAGE
 * =====================================================
 */

async function getWhisperMessage(
  env,
  messageId
) {
  return await env.DB.prepare(`
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
      u.server
        AS user_server,
      u.role,

      wr.name
        AS room_name

    FROM whisper_messages wm

    JOIN users u
      ON u.id =
        wm.user_id

    JOIN whisper_rooms wr
      ON wr.id =
        wm.room_id

    WHERE wm.id = ?

    LIMIT 1
  `)
    .bind(
      messageId
    )
    .first();
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
        targetUserId ||
        null,
        action,
        JSON.stringify(
          details || {}
        ),
        now
      )
      .run();

  } catch (error) {
    console.error(
      "Moderation log error:",
      error
    );
  }
}


/*
 * =====================================================
 * OPEN REPORT COUNT
 * =====================================================
 *
 * Moderator:
 * nur offene Meldungen gegen normale User.
 *
 * Admin:
 * alle offenen Meldungen außer gegen Admins.
 * =====================================================
 */

async function getOpenReportCount(
  env,
  actor
) {
  let query = `
    SELECT
      COUNT(*) AS total

    FROM chat_reports r

    JOIN users target
      ON target.id =
        r.reported_user_id

    WHERE r.status = 'open'
  `;

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

  const row =
    await env.DB
      .prepare(
        query
      )
      .first();

  return Number(
    row?.total ||
    0
  );
}


/*
 * =====================================================
 * FORMAT CONTEXT USER
 * =====================================================
 */

function formatContextUser(row) {
  return {
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
  };
}


/*
 * =====================================================
 * PUBLIC CONTEXT
 * =====================================================
 */

async function getPublicContext(
  env,
  message
) {
  let before;
  let after;

  if (
    message.room_type ===
    "global"
  ) {
    before =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.message,
          m.original_message,
          m.created_at,
          m.deleted_at,

          u.username,
          u.server,
          u.role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        WHERE m.room_type =
          'global'

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
      `)
        .bind(
          message.created_at,
          message.created_at,
          message.id
        )
        .all();

    after =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.message,
          m.original_message,
          m.created_at,
          m.deleted_at,

          u.username,
          u.server,
          u.role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        WHERE m.room_type =
          'global'

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
      `)
        .bind(
          message.created_at,
          message.created_at,
          message.id
        )
        .all();

  } else {
    before =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.message,
          m.original_message,
          m.created_at,
          m.deleted_at,

          u.username,
          u.server,
          u.role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        WHERE m.room_type =
          'server'

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
      `)
        .bind(
          message.server,
          message.created_at,
          message.created_at,
          message.id
        )
        .all();

    after =
      await env.DB.prepare(`
        SELECT
          m.id,
          m.user_id,
          m.message,
          m.original_message,
          m.created_at,
          m.deleted_at,

          u.username,
          u.server,
          u.role

        FROM chat_messages m

        JOIN users u
          ON u.id =
            m.user_id

        WHERE m.room_type =
          'server'

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
      `)
        .bind(
          message.server,
          message.created_at,
          message.created_at,
          message.id
        )
        .all();
  }

  const beforeRows =
    [
      ...(
        before.results ||
        []
      )
    ].reverse();

  const afterRows =
    after.results ||
    [];

  function format(row) {
    return {
      id:
        row.id,

      user:
        formatContextUser(
          row
        ),

      message:
        row.message,

      original_message:
        row.original_message ||
        row.message,

      created_at:
        row.created_at,

      deleted:
        Boolean(
          row.deleted_at
        )
    };
  }

  return [
    ...beforeRows.map(
      format
    ),

    {
      id:
        message.id,

      reported:
        true,

      user: {
        id:
          message.user_id,

        username:
          message.username,

        server:
          message.user_server,

        role:
          message.role,

        is_admin:
          message.role ===
          "admin",

        is_moderator:
          message.role ===
          "moderator"
      },

      message:
        message.message,

      original_message:
        message.original_message ||
        message.message,

      created_at:
        message.created_at,

      deleted:
        Boolean(
          message.deleted_at
        )
    },

    ...afterRows.map(
      format
    )
  ];
}


/*
 * =====================================================
 * WHISPER CONTEXT
 * =====================================================
 */

async function getWhisperContext(
  env,
  message
) {
  const before =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.user_id,
        wm.message,
        wm.original_message,
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

        AND (
          wm.created_at < ?

          OR (
            wm.created_at = ?
            AND wm.id < ?
          )
        )

      ORDER BY
        wm.created_at DESC,
        wm.id DESC

      LIMIT 5
    `)
      .bind(
        message.room_id,
        message.created_at,
        message.created_at,
        message.id
      )
      .all();

  const after =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.user_id,
        wm.message,
        wm.original_message,
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

        AND (
          wm.created_at > ?

          OR (
            wm.created_at = ?
            AND wm.id > ?
          )
        )

      ORDER BY
        wm.created_at ASC,
        wm.id ASC

      LIMIT 5
    `)
      .bind(
        message.room_id,
        message.created_at,
        message.created_at,
        message.id
      )
      .all();

  const beforeRows =
    [
      ...(
        before.results ||
        []
      )
    ].reverse();

  const afterRows =
    after.results ||
    [];

  function format(row) {
    return {
      id:
        row.id,

      user:
        formatContextUser(
          row
        ),

      message:
        row.message,

      original_message:
        row.original_message ||
        row.message,

      created_at:
        row.created_at,

      deleted:
        Boolean(
          row.deleted_at
        )
    };
  }

  return [
    ...beforeRows.map(
      format
    ),

    {
      id:
        message.id,

      reported:
        true,

      user: {
        id:
          message.user_id,

        username:
          message.username,

        server:
          message.user_server,

        role:
          message.role,

        is_admin:
          message.role ===
          "admin",

        is_moderator:
          message.role ===
          "moderator"
      },

      message:
        message.message,

      original_message:
        message.original_message ||
        message.message,

      created_at:
        message.created_at,

      deleted:
        Boolean(
          message.deleted_at
        )
    },

    ...afterRows.map(
      format
    )
  ];
}


/*
 * =====================================================
 * FORMAT REPORT
 * =====================================================
 */

async function formatReport(
  env,
  report
) {
  const base = {
    id:
      report.id,

    report_type:
      report.report_type ||
      (
        report.whisper_message_id
          ? "whisper"
          : "public"
      ),

    reason:
      report.reason ||
      null,

    status:
      report.status,

    created_at:
      report.created_at,

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
        report.reported_username,

      server:
        report.reported_server,

      role:
        report.reported_role,

      is_admin:
        report.reported_role ===
        "admin",

      is_moderator:
        report.reported_role ===
        "moderator"
    },

    message_id:
      report.message_id ||
      null,

    whisper_message_id:
      report.whisper_message_id ||
      null
  };


  /*
   * =================================================
   * WHISPER REPORT
   * =================================================
   */

  if (
    base.report_type ===
      "whisper" ||
    report.whisper_message_id
  ) {
    const message =
      await getWhisperMessage(
        env,
        report.whisper_message_id
      );

    if (!message) {
      return {
        ...base,

        message:
          null,

        room:
          null,

        context:
          []
      };
    }

    return {
      ...base,

      room: {
        type:
          "whisper",

        id:
          message.room_id,

        name:
          message.room_name ||
          null
      },

      message: {
        id:
          message.id,

        message:
          message.message,

        original_message:
          message.original_message ||
          message.message,

        created_at:
          message.created_at,

        deleted:
          Boolean(
            message.deleted_at
          )
      },

      context:
        await getWhisperContext(
          env,
          message
        )
    };
  }


  /*
   * =================================================
   * PUBLIC REPORT
   * =================================================
   */

  const message =
    await getPublicMessage(
      env,
      report.message_id
    );

  if (!message) {
    return {
      ...base,

      message:
        null,

      room:
        null,

      context:
        []
    };
  }

  return {
    ...base,

    room: {
      type:
        message.room_type,

      server:
        message.server
    },

    message: {
      id:
        message.id,

      message:
        message.message,

      original_message:
        message.original_message ||
        message.message,

      created_at:
        message.created_at,

      deleted:
        Boolean(
          message.deleted_at
        )
    },

    context:
      await getPublicContext(
        env,
        message
      )
  };
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * /api/chat/reports
 *
 * /api/chat/reports?status=reviewed
 *
 * /api/chat/reports?status=closed
 *
 * /api/chat/reports?status=all
 *
 * /api/chat/reports?count=1
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


    /*
     * =================================================
     * FAST BADGE COUNT
     * =================================================
     */

    if (
      url.searchParams.get(
        "count"
      ) ===
      "1"
    ) {
      const openCount =
        await getOpenReportCount(
          env,
          actor
        );

      return json({
        ok:
          true,

        open_count:
          openCount
      });
    }


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
          "Ungültiger Meldungsstatus."
      }, 400);
    }


    let rawLimit =
      Number(
        url.searchParams.get(
          "limit"
        ) ||
        100
      );

    if (
      !Number.isInteger(
        rawLimit
      )
    ) {
      rawLimit =
        100;
    }

    const limit =
      Math.max(
        1,
        Math.min(
          rawLimit,
          200
        )
      );


    /*
     * =================================================
     * REPORT QUERY
     * =================================================
     */

    let query = `
      SELECT
        r.id,
        r.reporter_id,
        r.reported_user_id,
        r.message_id,
        r.whisper_message_id,
        r.report_type,
        r.reason,
        r.status,
        r.created_at,

        reporter.username
          AS reporter_username,

        reporter.server
          AS reporter_server,

        reporter.role
          AS reporter_role,

        reported.username
          AS reported_username,

        reported.server
          AS reported_server,

        reported.role
          AS reported_role

      FROM chat_reports r

      JOIN users reporter
        ON reporter.id =
          r.reporter_id

      JOIN users reported
        ON reported.id =
          r.reported_user_id

      WHERE 1 = 1
    `;

    const bindings =
      [];


    /*
     * STATUS
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
     * ROLE HIERARCHY
     */

    if (
      isModerator(
        actor
      )
    ) {
      query += `
        AND reported.role = 'user'
      `;

    } else {
      query += `
        AND reported.role != 'admin'
      `;
    }


    query += `
      ORDER BY
        r.created_at DESC,
        r.id DESC

      LIMIT ?
    `;

    bindings.push(
      limit
    );


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
      reports.push(
        await formatReport(
          env,
          report
        )
      );
    }


    const openCount =
      await getOpenReportCount(
        env,
        actor
      );


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

      open_count:
        openCount,

      reports
    });

  } catch (error) {
    console.error(
      "GET /api/chat/reports error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Meldungen konnten nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Öffentliche Nachricht:
 *
 * {
 *   "message_id": 123,
 *   "reason": "Spam"
 * }
 *
 *
 * Whisper:
 *
 * {
 *   "whisper_message_id": 456,
 *   "reason": "Beleidigung"
 * }
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


    const reason =
      normalizeText(
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


    const messageId =
      toPositiveInt(
        body.message_id
      );


    const whisperMessageId =
      toPositiveInt(
        body.whisper_message_id
      );


    /*
     * Genau eines von beiden.
     */

    if (
      Boolean(
        messageId
      ) ===
      Boolean(
        whisperMessageId
      )
    ) {
      return json({
        ok:
          false,

        error:
          "Es muss genau eine Nachricht gemeldet werden."
      }, 400);
    }


    let targetUser;
    let reportType;


    /*
     * =================================================
     * PUBLIC
     * =================================================
     */

    if (
      messageId
    ) {
      const message =
        await getPublicMessage(
          env,
          messageId
        );

      if (!message) {
        return json({
          ok:
            false,

          error:
            "Die Nachricht wurde nicht gefunden."
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


      targetUser =
        await getUserById(
          env,
          message.user_id
        );


      reportType =
        "public";
    }


    /*
     * =================================================
     * WHISPER
     * =================================================
     */

    if (
      whisperMessageId
    ) {
      const message =
        await getWhisperMessage(
          env,
          whisperMessageId
        );

      if (!message) {
        return json({
          ok:
            false,

          error:
            "Die Whisper-Nachricht wurde nicht gefunden."
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
       * Reporter muss tatsächlich Mitglied sein.
       *
       * Kein Admin-/Moderator-Bypass.
       */

      const membership =
        await env.DB.prepare(`
          SELECT 1

          FROM whisper_members

          WHERE room_id = ?
            AND user_id = ?

          LIMIT 1
        `)
          .bind(
            message.room_id,
            user.id
          )
          .first();


      if (
        !membership
      ) {
        return json({
          ok:
            false,

          error:
            "Du hast keinen Zugriff auf diesen Whisper-Chat."
        }, 403);
      }


      targetUser =
        await getUserById(
          env,
          message.user_id
        );


      reportType =
        "whisper";
    }


    if (
      !targetUser
    ) {
      return json({
        ok:
          false,

        error:
          "Der gemeldete Spieler wurde nicht gefunden."
      }, 404);
    }


    /*
     * =================================================
     * ADMIN IMMUNITY
     * =================================================
     *
     * Moderatoren DÜRFEN gemeldet werden.
     *
     * Diese Meldungen sieht später nur der Admin.
     */

    if (
      targetUser.role ===
      "admin"
    ) {
      return json({
        ok:
          false,

        error:
          "Der Administrator kann nicht gemeldet werden."
      }, 403);
    }


    if (
      Number(
        targetUser.id
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
     * DUPLICATE REPORT
     * =================================================
     */

    let duplicate;


    if (
      reportType ===
      "public"
    ) {
      duplicate =
        await env.DB.prepare(`
          SELECT
            id

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

    } else {
      duplicate =
        await env.DB.prepare(`
          SELECT
            id

          FROM chat_reports

          WHERE reporter_id = ?
            AND whisper_message_id = ?

            AND status IN (
              'open',
              'reviewed'
            )

          LIMIT 1
        `)
          .bind(
            user.id,
            whisperMessageId
          )
          .first();
    }


    if (
      duplicate
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


    const insert =
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
          targetUser.id,
          messageId ||
          null,
          whisperMessageId ||
          null,
          reportType,
          reason,
          now
        )
        .run();


    return json({
      ok:
        true,

      report: {
        id:
          insert?.meta
            ?.last_row_id ||
          null,

        report_type:
          reportType,

        reported_user: {
          id:
            targetUser.id,

          username:
            targetUser.username,

          server:
            targetUser.server,

          role:
            targetUser.role,

          is_moderator:
            targetUser.role ===
            "moderator"
        },

        reason,

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
      ok:
        false,

      error:
        "Die Nachricht konnte nicht gemeldet werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * STAFF:
 *
 * {
 *   "id": 12,
 *   "status": "reviewed"
 * }
 *
 * oder:
 *
 * {
 *   "id": 12,
 *   "status": "closed"
 * }
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
        body.id ||
        body.report_id
      );


    const status =
      normalizeText(
        body.status
      )
        .toLowerCase();


    if (
      !reportId
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Meldungs-ID."
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
          "Ungültiger Meldungsstatus."
      }, 400);
    }


    const report =
      await env.DB.prepare(`
        SELECT
          r.id,
          r.reported_user_id,
          r.report_type,
          r.message_id,
          r.whisper_message_id,
          r.reason,
          r.status,

          target.username,
          target.server,
          target.role

        FROM chat_reports r

        JOIN users target
          ON target.id =
            r.reported_user_id

        WHERE r.id = ?

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
          "Meldung wurde nicht gefunden."
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
     * ROLE HIERARCHY
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
            "Meldungen gegen Administratoren können nicht bearbeitet werden."
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
            "Meldungen gegen Moderatoren können nur vom Administrator bearbeitet werden."
        }, 403);
      }


      return json({
        ok:
          false,

        error:
          "Du darfst diese Meldung nicht bearbeiten."
      }, 403);
    }


    const oldStatus =
      report.status;


    /*
     * Nichts geändert.
     */

    if (
      oldStatus ===
      status
    ) {
      const openCount =
        await getOpenReportCount(
          env,
          actor
        );

      return json({
        ok:
          true,

        unchanged:
          true,

        report_id:
          reportId,

        status,

        open_count:
          openCount
      });
    }


    await env.DB.prepare(`
      UPDATE chat_reports

      SET status = ?

      WHERE id = ?
    `)
      .bind(
        status,
        reportId
      )
      .run();


    await addModerationLog(
      env,
      actor.id,
      report.reported_user_id,
      "update_report_status",
      {
        report_id:
          reportId,

        report_type:
          report.report_type,

        message_id:
          report.message_id,

        whisper_message_id:
          report.whisper_message_id,

        actor_role:
          actor.role,

        target_username:
          report.username,

        old_status:
          oldStatus,

        new_status:
          status
      }
    );


    const openCount =
      await getOpenReportCount(
        env,
        actor
      );


    return json({
      ok:
        true,

      unchanged:
        false,

      report_id:
        reportId,

      status,

      open_count:
        openCount,

      message:
        status ===
          "closed"
          ? "Die Meldung wurde geschlossen."
          : status ===
              "reviewed"
            ? "Die Meldung wurde als geprüft markiert."
            : "Die Meldung wurde wieder geöffnet."
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/reports error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Meldung konnte nicht aktualisiert werden."
    }, 500);
  }
}


/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Meldungen bleiben aus Moderationsgründen erhalten.
 * =====================================================
 */

export async function onRequestDelete() {
  return json({
    ok:
      false,

    error:
      "Meldungen können nicht gelöscht werden. Schließe die Meldung stattdessen."
  }, 405);
}
