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
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();

    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) continue;

    const key = trimmed
      .slice(0, separatorIndex)
      .trim();

    const value = trimmed
      .slice(separatorIndex + 1)
      .trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

async function tableExists(env, tableName) {
  const row = await env.DB.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `)
    .bind(tableName)
    .first();

  return Boolean(row);
}

async function getTableColumns(env, tableName) {
  if (!(await tableExists(env, tableName))) {
    return [];
  }

  const result = await env.DB.prepare(
    `PRAGMA table_info(${tableName})`
  ).all();

  return Array.isArray(result.results)
    ? result.results
    : [];
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(
    request,
    "ps_session"
  );

  if (!sessionId) {
    return null;
  }

  const now = Math.floor(
    Date.now() / 1000
  );

  const user = await env.DB.prepare(`
    SELECT
      users.*
    FROM sessions
    JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(sessionId, now)
    .first();

  return user || null;
}

async function safeCount(
  env,
  tableName,
  columnName,
  userId
) {
  if (!(await tableExists(env, tableName))) {
    return 0;
  }

  const columns =
    await getTableColumns(env, tableName);

  if (
    !columns.some(
      (column) => column.name === columnName
    )
  ) {
    return 0;
  }

  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM ${tableName}
    WHERE ${columnName} = ?
  `)
    .bind(userId)
    .first();

  return Number(row?.total || 0);
}

async function safeRows(
  env,
  tableName,
  columnName,
  userId,
  selectFields,
  orderColumn = null,
  limit = 500
) {
  if (!(await tableExists(env, tableName))) {
    return [];
  }

  const columns =
    await getTableColumns(env, tableName);

  const columnNames = new Set(
    columns.map((column) => column.name)
  );

  if (!columnNames.has(columnName)) {
    return [];
  }

  const safeFields = selectFields.filter(
    (field) => columnNames.has(field)
  );

  if (safeFields.length === 0) {
    return [];
  }

  let orderClause = "";

  if (
    orderColumn &&
    columnNames.has(orderColumn)
  ) {
    orderClause =
      `ORDER BY ${orderColumn} DESC`;
  }

  const safeLimit = Math.min(
    Math.max(Number(limit) || 500, 1),
    2000
  );

  const result = await env.DB.prepare(`
    SELECT ${safeFields.join(", ")}
    FROM ${tableName}
    WHERE ${columnName} = ?
    ${orderClause}
    LIMIT ${safeLimit}
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

function cleanAccountData(user) {
  /*
    Niemals Passwort-Hash oder ähnliche
    Authentifizierungsgeheimnisse ausgeben.
  */
  const excluded = new Set([
    "password",
    "password_hash",
    "password_salt",
    "salt",
    "reset_token",
    "verification_token",
    "two_factor_secret",
    "totp_secret"
  ]);

  const result = {};

  for (
    const [key, value]
    of Object.entries(user || {})
  ) {
    if (excluded.has(key)) {
      continue;
    }

    result[key] = value;
  }

  /*
    Für die Anzeige bleibt unser Admin
    natürlich ADMIN.
  */
  if (user?.role === "admin") {
    result.server_display = "ADMIN";
  } else {
    result.server_display =
      user?.server || null;
  }

  return result;
}

async function getWhisperMemberships(
  env,
  userId
) {
  if (
    !(await tableExists(env, "whisper_members")) ||
    !(await tableExists(env, "whisper_rooms"))
  ) {
    return [];
  }

  const result = await env.DB.prepare(`
    SELECT
      whisper_rooms.id AS room_id,
      whisper_rooms.name,
      whisper_rooms.created_by,
      whisper_rooms.created_at,
      whisper_members.joined_at
    FROM whisper_members
    JOIN whisper_rooms
      ON whisper_rooms.id =
         whisper_members.room_id
    WHERE whisper_members.user_id = ?
    ORDER BY whisper_rooms.created_at DESC
    LIMIT 500
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

async function getOwnWhisperMessages(
  env,
  userId
) {
  if (
    !(await tableExists(env, "whisper_messages"))
  ) {
    return [];
  }

  const columns =
    await getTableColumns(
      env,
      "whisper_messages"
    );

  const names = new Set(
    columns.map((column) => column.name)
  );

  const fields = [
    "id",
    "room_id",
    "message",
    "reply_to",
    "created_at",
    "deleted_at"
  ].filter(
    (field) => names.has(field)
  );

  if (fields.length === 0) {
    return [];
  }

  /*
    original_message wird hier bewusst
    nicht ausgegeben.

    Das Feld verwenden wir intern unter
    anderem für Moderation/Wortfilter.
  */
  const result = await env.DB.prepare(`
    SELECT ${fields.join(", ")}
    FROM whisper_messages
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1000
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

async function getOwnPublicMessages(
  env,
  userId
) {
  if (
    !(await tableExists(env, "chat_messages"))
  ) {
    return [];
  }

  const columns =
    await getTableColumns(
      env,
      "chat_messages"
    );

  const names = new Set(
    columns.map((column) => column.name)
  );

  const fields = [
    "id",
    "room_type",
    "server",
    "message",
    "reply_to",
    "created_at",
    "deleted_at"
  ].filter(
    (field) => names.has(field)
  );

  if (fields.length === 0) {
    return [];
  }

  const result = await env.DB.prepare(`
    SELECT ${fields.join(", ")}
    FROM chat_messages
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1000
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

async function getOwnLegalReports(
  env,
  userId
) {
  if (
    !(await tableExists(
      env,
      "legal_content_reports"
    ))
  ) {
    return [];
  }

  const result = await env.DB.prepare(`
    SELECT
      id,
      reporter_name,
      reporter_email,
      content_type,
      content_location,
      content_reference,
      reason,
      status,
      created_at,
      updated_at,
      resolved_at
    FROM legal_content_reports
    WHERE reporter_user_id = ?
    ORDER BY created_at DESC
    LIMIT 500
  `)
    .bind(userId)
    .all();

  /*
    admin_note und interne Verwaltungsinformationen
    werden nicht in dieser Self-Service-Ansicht
    veröffentlicht.
  */
  return result.results || [];
}

async function getOwnReports(
  env,
  userId
) {
  if (
    !(await tableExists(env, "chat_reports"))
  ) {
    return [];
  }

  const columns =
    await getTableColumns(
      env,
      "chat_reports"
    );

  const names = new Set(
    columns.map((column) => column.name)
  );

  const fields = [
    "id",
    "message_id",
    "whisper_message_id",
    "report_type",
    "reason",
    "status",
    "created_at"
  ].filter(
    (field) => names.has(field)
  );

  if (fields.length === 0) {
    return [];
  }

  const result = await env.DB.prepare(`
    SELECT ${fields.join(", ")}
    FROM chat_reports
    WHERE reporter_id = ?
    ORDER BY created_at DESC
    LIMIT 500
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

async function getChatSettings(
  env,
  userId
) {
  if (
    !(await tableExists(
      env,
      "chat_user_settings"
    ))
  ) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT
      show_system_messages,
      show_timestamps,
      emoji_picker_enabled,
      created_at,
      updated_at
    FROM chat_user_settings
    WHERE user_id = ?
    LIMIT 1
  `)
    .bind(userId)
    .first();
}

async function getBlocks(
  env,
  userId
) {
  if (
    !(await tableExists(env, "chat_blocks"))
  ) {
    return {
      blocked_by_me: [],
      blocked_me: []
    };
  }

  const blockedByMe =
    await env.DB.prepare(`
      SELECT
        chat_blocks.id,
        chat_blocks.blocked_id,
        chat_blocks.created_at,
        users.username
      FROM chat_blocks
      LEFT JOIN users
        ON users.id =
           chat_blocks.blocked_id
      WHERE chat_blocks.blocker_id = ?
      ORDER BY chat_blocks.created_at DESC
      LIMIT 500
    `)
      .bind(userId)
      .all();

  /*
    Hier geben wir NICHT aus, wer den Nutzer
    blockiert hat.

    Das schützt die Privatsphäre anderer Nutzer.

    Wir teilen lediglich mit, wie viele
    entsprechende Beziehungen existieren.
  */
  const blockedMeCount =
    await safeCount(
      env,
      "chat_blocks",
      "blocked_id",
      userId
    );

  return {
    blocked_by_me:
      blockedByMe.results || [],

    blocked_me_count:
      blockedMeCount
  };
}

async function getPresenceData(
  env,
  userId
) {
  const result = {
    chat_presence: null,
    site_presence_entries: 0
  };

  if (
    await tableExists(env, "chat_presence")
  ) {
    result.chat_presence =
      await env.DB.prepare(`
        SELECT
          last_seen,
          room_type,
          server
        FROM chat_presence
        WHERE user_id = ?
        LIMIT 1
      `)
        .bind(userId)
        .first();
  }

  if (
    await tableExists(env, "site_presence")
  ) {
    const row =
      await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM site_presence
        WHERE user_id = ?
      `)
        .bind(userId)
        .first();

    result.site_presence_entries =
      Number(row?.total || 0);
  }

  return result;
}

async function getSummary(
  env,
  userId
) {
  const [
    publicMessages,
    whisperMessages,
    reportsSubmitted,
    reportsAboutUser,
    legalReports,
    kicks,
    bans
  ] = await Promise.all([
    safeCount(
      env,
      "chat_messages",
      "user_id",
      userId
    ),

    safeCount(
      env,
      "whisper_messages",
      "user_id",
      userId
    ),

    safeCount(
      env,
      "chat_reports",
      "reporter_id",
      userId
    ),

    safeCount(
      env,
      "chat_reports",
      "reported_user_id",
      userId
    ),

    safeCount(
      env,
      "legal_content_reports",
      "reporter_user_id",
      userId
    ),

    safeCount(
      env,
      "chat_kicks",
      "user_id",
      userId
    ),

    safeCount(
      env,
      "chat_bans",
      "user_id",
      userId
    )
  ]);

  return {
    public_messages: publicMessages,
    whisper_messages: whisperMessages,
    reports_submitted: reportsSubmitted,
    reports_about_account: reportsAboutUser,
    legal_reports_submitted: legalReports,
    kicks: kicks,
    bans: bans
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "Database binding missing."
        },
        500
      );
    }

    const currentUser =
      await getCurrentUser(request, env);

    if (!currentUser) {
      return json(
        {
          ok: false,
          error: "Not logged in."
        },
        401
      );
    }

    const userId =
      currentUser.id;

    const [
      summary,
      publicMessages,
      whisperMessages,
      whisperRooms,
      reports,
      legalReports,
      chatSettings,
      blocks,
      presence
    ] = await Promise.all([
      getSummary(
        env,
        userId
      ),

      getOwnPublicMessages(
        env,
        userId
      ),

      getOwnWhisperMessages(
        env,
        userId
      ),

      getWhisperMemberships(
        env,
        userId
      ),

      getOwnReports(
        env,
        userId
      ),

      getOwnLegalReports(
        env,
        userId
      ),

      getChatSettings(
        env,
        userId
      ),

      getBlocks(
        env,
        userId
      ),

      getPresenceData(
        env,
        userId
      )
    ]);

    /*
      Wir geben keine Sessions aus.

      Session-IDs sind Authentifizierungsgeheimnisse
      und gehören nicht in einen normalen
      Self-Service-Datendownload.
    */

    return json({
      ok: true,

      generated_at:
        Math.floor(Date.now() / 1000),

      account:
        cleanAccountData(currentUser),

      summary,

      data: {
        public_chat_messages:
          publicMessages,

        own_whisper_messages:
          whisperMessages,

        whisper_memberships:
          whisperRooms,

        reports_submitted:
          reports,

        legal_reports_submitted:
          legalReports,

        chat_settings:
          chatSettings,

        blocks,

        presence
      },

      information: {
        purpose:
          "Operation of the PirateStorm.info community platform, user account, forum/chat functions, moderation, abuse prevention and site operation.",

        recipients: [
          "Site operator/administrator",
          "Technical hosting and infrastructure providers where necessary for operation"
        ],

        rights: [
          "Access",
          "Rectification",
          "Erasure",
          "Restriction of processing",
          "Objection where applicable",
          "Data portability where applicable",
          "Complaint to a supervisory authority"
        ],

        note:
          "This self-service view contains account-related information that can be safely displayed automatically. A formal data-protection request may cover additional information depending on the circumstances."
      }
    });
  } catch (error) {
    console.error(
      "Account data GET error:",
      error
    );

    return json(
      {
        ok: false,
        error: "Internal server error."
      },
      500
    );
  }
}

export async function onRequestPost() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

export async function onRequestPut() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

export async function onRequestPatch() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}

export async function onRequestDelete() {
  return json(
    {
      ok: false,
      error: "Method not allowed."
    },
    405
  );
}
